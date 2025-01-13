import fetch from 'node-fetch';
import { Bot } from '@skyware/bot';
import http from 'http';

// Configuration
const config = {
  INITIAL_DELAY: 45000,
  POST_DELAY: 180000,
  MAX_UPDATES: 2,
  POLL_INTERVAL: 60000,
  API_BASE_URL: 'https://api-web.nhle.com/v1',
  SCORE_MAX_AGE: 6 * 60 * 60 * 1000, // 6 hours in milliseconds
};

// Validate environment variables
if (!process.env.BLUESKY_PASSWORD) {
  throw new Error('BLUESKY_PASSWORD environment variable is required');
}

globalThis.fetch = fetch;
globalThis.Headers = fetch.Headers;

const bot = new Bot();
let previousScores = {};

// Utility functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isToday(timestamp) {
  const today = new Date();
  const date = new Date(timestamp);
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
}

function safeStringify(obj) {
  try {
    const cache = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (cache.has(value)) {
          return '[Circular Reference]';
        }
        cache.add(value);
      }
      return value;
    });
  } catch (error) {
    return '[Unable to stringify]';
  }
}

function createGoalKey(gameId, goal) {
  const minutes = goal.time.split(':')[0];
  return `${gameId}-${goal.eventId}-${goal.scorer}-${goal.period}-${minutes}-${goal.rawScores.away}-${goal.rawScores.home}`;
}

function cleanupOldScores() {
  const now = Date.now();
  const initialCount = Object.keys(previousScores).length;
  
  Object.keys(previousScores).forEach(key => {
    // Remove scores older than 6 hours or from a different day
    if (!isToday(previousScores[key].timestamp) || 
        (now - previousScores[key].timestamp) > config.SCORE_MAX_AGE) {
      console.log(`Removing old goal: ${key}`, {
        age: Math.round((now - previousScores[key].timestamp) / 1000 / 60) + ' minutes',
        wasToday: isToday(previousScores[key].timestamp)
      });
      delete previousScores[key];
    }
  });

  const finalCount = Object.keys(previousScores).length;
  if (initialCount !== finalCount) {
    console.log(`Cleaned up ${initialCount - finalCount} old goals. ${finalCount} remaining.`);
  }
}

// Message formatting
function formatGoalMessage(goal, teams, isUpdate = false) {
  let message = isUpdate ? 'Updated Goal Info:\n' : 'GOAL! 🚨\n';
  message += `${teams.away} vs. ${teams.home}\n`;
  message += `${goal.scorer} (${goal.team}) ${isUpdate ? 'was' : 'is'} the scorer!`;
  if (goal.assists) {
    message += `\nAssists: ${goal.assists}`;
  }
  message += `\nTime: ${goal.time} - ${goal.period}`;
  message += `\nScore: ${goal.score}`;
  return message;
}

// Data validation
function validateGameData(data) {
  if (!data?.plays || !Array.isArray(data.plays)) {
    throw new Error('Invalid game data structure');
  }
  return data;
}

// API functions
async function fetchNHLSchedule() {
  try {
    const response = await fetch(`${config.API_BASE_URL}/schedule/now`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching NHL schedule:', error.message);
    throw error;
  }
}

async function fetchGamePlayByPlay(gameId) {
  try {
    const response = await fetch(`${config.API_BASE_URL}/gamecenter/${gameId}/play-by-play`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const contentType = response.headers.get('Content-Type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error(`Unexpected Content-Type: ${contentType}`);
    }

    const data = await response.json();
    return validateGameData(data);
  } catch (error) {
    console.error(`Error fetching play-by-play for game ${gameId}:`, error.message);
    throw error;
  }
}

// Goal processing
function processGoalPlay(play, data) {
  try {
    if (!play.details) {
      throw new Error("Invalid play.details structure");
    }

    const { scoringPlayerId, eventOwnerTeamId, assists = [] } = play.details;
    const scorer = data.rosterSpots.find(player => player.playerId === scoringPlayerId);

    // Log score details for debugging
    console.log(`Processing goal - Scores from play details:`, {
      awayScore: play.details.awayScore,
      homeScore: play.details.homeScore,
      timeInPeriod: play.timeInPeriod,
      period: play.periodDescriptor.number
    });

    const processedAssists = assists
      .map(assist => {
        const assister = data.rosterSpots.find(player => player.playerId === assist.playerId);
        return assister ? `${assister.firstName.default} ${assister.lastName.default} (#${assister.sweaterNumber})` : 'Unknown Player';
      })
      .join(', ');

    const scoringTeam = eventOwnerTeamId === data.homeTeam.id
      ? data.homeTeam.abbrev
      : data.awayTeam.abbrev;

    return {
      eventId: play.eventId,
      scorer: scorer ? `${scorer.firstName.default} ${scorer.lastName.default} (#${scorer.sweaterNumber})` : 'Unknown Player',
      assists: processedAssists,
      time: play.timeInPeriod,
      period: play.periodDescriptor.periodType === 'REG'
        ? play.periodDescriptor.number
        : play.periodDescriptor.periodType,
      team: scoringTeam || 'Unknown Team',
      score: `${play.details.awayScore} - ${play.details.homeScore}`,
      rawScores: {
        away: play.details.awayScore,
        home: play.details.homeScore
      }
    };
  } catch (error) {
    console.error("Error processing goal play:", error.message);
    return null;
  }
}

async function handleGoalUpdate(gameId, goal, teams) {
  try {
    const goalKey = createGoalKey(gameId, goal);
    
    // Check if this goal exists in previousScores and is from a different day
    if (previousScores[goalKey] && !isToday(previousScores[goalKey].timestamp)) {
      console.log(`Removing old goal entry for ${goalKey} from a different day`);
      delete previousScores[goalKey];
    }

    const goalMinute = goal.time.split(':')[0];
    const goalPeriod = goal.period;
    
    // Check for existing goals that are the same except for seconds
    const isDuplicate = Object.entries(previousScores).some(([key, value]) => {
      if (key.startsWith(gameId) && value.posted && isToday(value.timestamp)) {
        const prevGoal = value.goal;
        const prevMinute = prevGoal.time.split(':')[0];
        
        return prevGoal.period === goalPeriod && 
               prevMinute === goalMinute && 
               prevGoal.scorer === goal.scorer &&
               prevGoal.rawScores.away === goal.rawScores.away &&
               prevGoal.rawScores.home === goal.rawScores.home;
      }
      return false;
    });

    if (isDuplicate) {
      console.log(`Skipping duplicate goal/time update:`, {
        period: goalPeriod,
        minute: goalMinute,
        scorer: goal.scorer,
        score: `${goal.rawScores.away}-${goal.rawScores.home}`
      });
      return;
    }

    console.log(`Processing goal with key: ${goalKey}`, {
      exists: !!previousScores[goalKey],
      updateCount: previousScores[goalKey]?.updateCount || 0,
      isPosted: previousScores[goalKey]?.posted || false
    });

    if (!previousScores[goalKey]) {
      const now = Date.now();
      previousScores[goalKey] = {
        firstSeen: now,
        posted: false,
        updateCount: 0,
        timestamp: now,
        goal: goal
      };

      console.log(`New goal detected, waiting ${config.INITIAL_DELAY}ms before posting...`);
      await delay(config.INITIAL_DELAY);

      try {
        const updatedData = await fetchGamePlayByPlay(gameId);
        const updatedGoalPlay = updatedData.plays.find(play => play.eventId === goal.eventId);

        if (updatedGoalPlay && !previousScores[goalKey].posted) {
          const message = formatGoalMessage(goal, teams);
          console.log("Attempting to post message:", message);

          await bot.post({ text: message });
          console.log(`Successfully posted goal ${goalKey}`);
          
          previousScores[goalKey].posted = true;
          previousScores[goalKey].timestamp = Date.now(); // Update timestamp after successful post
          await delay(config.POST_DELAY);
        } else {
          console.log(`Goal ${goalKey} was either already posted or no longer exists`);
          delete previousScores[goalKey];
        }
      } catch (error) {
        console.error(`Error posting goal ${goalKey}:`, error.message);
        delete previousScores[goalKey];
      }
    } else if (previousScores[goalKey].posted && 
               previousScores[goalKey].updateCount < config.MAX_UPDATES && 
               isToday(previousScores[goalKey].timestamp)) {
      previousScores[goalKey].updateCount++;
      const previousGoal = previousScores[goalKey].goal;
      const updatedFields = getUpdatedFields(goal, previousGoal);

      if (updatedFields.length > 0) {
        const message = formatGoalMessage(goal, teams, true);
        try {
          await bot.post({ text: message });
          console.log(`Successfully posted update for goal ${goalKey}`);
          previousScores[goalKey].goal = goal;
          previousScores[goalKey].timestamp = Date.now();
        } catch (error) {
          console.error(`Error posting update for goal ${goalKey}:`, error.message);
        }
      }
    } else {
      console.log(`Skipping goal ${goalKey} - already processed or max updates reached`);
    }
  } catch (error) {
    console.error(`Error in handleGoalUpdate for game ${gameId}:`, error.message);
  }
}

function getUpdatedFields(newGoal, oldGoal) {
  const updatedFields = [];
  if (newGoal.scorer !== oldGoal.scorer) updatedFields.push('scorer');
  if (newGoal.assists !== oldGoal.assists) updatedFields.push('assists');
  if (newGoal.period !== oldGoal.period) updatedFields.push('period');
  if (newGoal.score !== oldGoal.score) updatedFields.push('score');
  return updatedFields;
}

async function startBot() {
  // Clear previousScores at startup
  previousScores = {};
  console.log('Cleared previous scores at startup');

  async function attemptLogin(maxRetries = 5, delayBetweenRetries = 30000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Attempting login (attempt ${attempt}/${maxRetries})...`);
        await bot.login({
          identifier: 'nhl-goal-bot.bsky.social',
          password: process.env.BLUESKY_PASSWORD
        });
        console.log('Bot successfully logged in');
        return true;
      } catch (error) {
        const isUpstreamError = 
          error.message.includes('Upstream') || 
          error.message.includes('Failed to fetch') ||
          (error.status === 502);

        console.error(`Login attempt ${attempt} failed:`, {
          message: error.message,
          status: error.status,
          error: error.error,
          isUpstreamError
        });
        
        if (attempt === maxRetries) {
          console.error('Max login attempts reached, will restart process');
          process.exit(1);
        }
        
        const nextDelay = isUpstreamError ? delayBetweenRetries * 2 : delayBetweenRetries;
        console.log(`Waiting ${nextDelay/1000} seconds before retrying...`);
        await delay(nextDelay);
      }
    }
    return false;
  }

  while (true) {
    try {
      const loginSuccess = await attemptLogin();
      if (!loginSuccess) {
        throw new Error('Failed to login after maximum retries');
      }

      const pollGames = async () => {
        try {
          console.log("Fetching NHL scores at", new Date().toISOString());
          const scheduleData = await fetchNHLSchedule();

          const liveGameIds = scheduleData.gameWeek.flatMap(week =>
            week.games.filter(game => game.gameState === 'LIVE').map(game => game.id)
          );

          if (liveGameIds.length > 0) {
            console.log("Live game IDs:", liveGameIds);
          }

          for (const gameId of liveGameIds) {
            try {
              const data = await fetchGamePlayByPlay(gameId);
              const teams = {
                home: data.homeTeam.abbrev,
                away: data.awayTeam.abbrev
              };

              const newGoals = data.plays
                .filter(play => play.typeDescKey === 'goal' && play.details?.scoringPlayerId)
                .map(play => processGoalPlay(play, data))
                .filter(goal => goal !== null);

              for (const goal of newGoals) {
                await handleGoalUpdate(gameId, goal, teams);
              }
            } catch (error) {
              console.error(`Error processing game ${gameId}:`, error.message);
            }
          }

          cleanupOldScores();
        } catch (error) {
          console.error('Error in poll cycle:', error.message);
          if (error.message.includes('Failed to fetch') || 
              error.message.includes('Upstream') || 
              error.status === 502) {
                console.log('Connection issue detected, restarting bot...');
                throw error; // This will trigger process restart
              }
            }
          };
    
          // Set up polling interval
          let pollInterval = setInterval(pollGames, config.POLL_INTERVAL);
    
          // Handle process termination
          process.on('SIGTERM', () => {
            console.log('SIGTERM received, cleaning up...');
            clearInterval(pollInterval);
            process.exit(0);
          });
    
          process.on('SIGINT', () => {
            console.log('SIGINT received, cleaning up...');
            clearInterval(pollInterval);
            process.exit(0);
          });
    
          // Start initial poll
          await pollGames();
    
          // If we get here without error, break the while loop
          break;
    
        } catch (error) {
          console.error('Fatal error, restarting bot in 60 seconds:', error.message);
          await delay(60000);
          // Continue while loop to restart the whole process
        }
      }
    }
    
    // Start the bot
    startBot();
    
    // HTTP Server
    const port = process.env.PORT || 10000;
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'"
      });
      res.end('NHL Goal Bot is running!');
    });
    
    server.listen(port, () => {
      console.log(`NHL Goal Bot listening on port ${port}`);
    });