import fetch from 'node-fetch';
import { Bot } from '@skyware/bot';
import http from 'http';

// Configuration
const config = {
  INITIAL_DELAY: 45000,
  POST_DELAY: 60000,
  MAX_UPDATES: 2,
  POLL_INTERVAL: 45000,
  API_BASE_URL: 'https://api-web.nhle.com/v1',
  SCORE_MAX_AGE: 4 * 60 * 60 * 1000, // 4 hours in milliseconds
};

// Validate environment variables
if (!process.env.BLUESKY_PASSWORD) {
  throw new Error('BLUESKY_PASSWORD environment variable is required');
}

globalThis.fetch = fetch;
globalThis.Headers = fetch.Headers;

const bot = new Bot();
let previousScores = {};
let postingInProgress = {};

function setPostingLock(goalKey) {
  if (postingInProgress[goalKey]) {
    const lockAge = Date.now() - postingInProgress[goalKey];
    if (lockAge > 60000) { // If lock is older than 1 minute
      console.log(`Clearing stale lock for ${goalKey}, age: ${Math.round(lockAge/1000)}s`);
      delete postingInProgress[goalKey];
    } else {
      return false;
    }
  }
  postingInProgress[goalKey] = Date.now();
  return true;
}

function clearPostingLock(goalKey) {
  delete postingInProgress[goalKey];
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function getEasternTime(date = new Date()) {
  const utcTime = date.getTime();
  const etOffset = -5 * 60 * 60 * 1000;  // -5 hours in milliseconds for EST
  return new Date(utcTime + etOffset);
}

function formatEasternTime(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  });
}

function getAgeInMinutes(timestamp) {
  const now = Date.now();
  return Math.round((now - timestamp) / (1000 * 60));
}

function isToday(timestamp) {
  const etNow = getEasternTime();
  const etDate = getEasternTime(new Date(timestamp));
  return etDate.getDate() === etNow.getDate() &&
         etDate.getMonth() === etNow.getMonth() &&
         etDate.getFullYear() === etNow.getFullYear();
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

function getErrorInfo(error) {
  return {
    message: error.message,
    type: error.constructor.name,
    // Only include first few lines of stack trace to avoid circular refs
    stack: error.stack?.split('\n').slice(0, 3).join('\n')
  };
}

function createGoalKey(gameId, goal) {
  const minutes = goal.time.split(':')[0];
  return `${gameId}-${goal.eventId}-${goal.scorer}-${goal.period}-${minutes}-${goal.rawScores.away}-${goal.rawScores.home}`;
}

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

function validateGameData(data) {
  if (!data?.plays || !Array.isArray(data.plays)) {
    throw new Error('Invalid game data structure');
  }
  return data;
}

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

function processGoalPlay(play, data) {
  try {
    if (!play.details) {
      throw new Error("Invalid play.details structure");
    }

    const { scoringPlayerId, eventOwnerTeamId, assists = [] } = play.details;
    const scorer = data.rosterSpots.find(player => player.playerId === scoringPlayerId);

    console.log(`Processing goal - Scores from play details:`, {
      awayScore: play.details.awayScore,
      homeScore: play.details.homeScore,
      timeInPeriod: play.timeInPeriod,
      period: play.periodDescriptor.number,
      timestamp: formatEasternTime(new Date())
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

function getUpdatedFields(newGoal, oldGoal) {
  const updatedFields = [];
  if (newGoal.scorer !== oldGoal.scorer) updatedFields.push('scorer');
  if (newGoal.assists !== oldGoal.assists) updatedFields.push('assists');
  if (newGoal.period !== oldGoal.period) updatedFields.push('period');
  if (newGoal.score !== oldGoal.score) updatedFields.push('score');
  return updatedFields;
}

async function renewBotConnection() {
  console.log('Renewing Bluesky connection...');
  try {
    await bot.login({
      identifier: 'nhl-goal-bot.bsky.social',
      password: process.env.BLUESKY_PASSWORD
    });
    console.log('Successfully renewed Bluesky connection');
    return true;
  } catch (error) {
    console.error('Failed to renew Bluesky connection:', getErrorInfo(error));
    return false;
  }
}

async function handleGoalUpdate(gameId, goal, teams) {
  const goalKey = createGoalKey(gameId, goal);
  
  try {
    const now = Date.now();
    
    // Check if post is in progress with timeout
    if (!setPostingLock(goalKey)) {
      const lockAge = Math.round((now - postingInProgress[goalKey])/1000);
      console.log(`Skipping ${goalKey} - posting in progress for ${lockAge}s`);
      return;
    }

    try {
      // Force removal of any goals older than configured max age
      if (previousScores[goalKey]) {
        const ageInMinutes = getAgeInMinutes(previousScores[goalKey].timestamp);
        
        console.log(`Checking age for goal ${goalKey}:`, {
          ageInMinutes,
          timestamp: formatEasternTime(new Date(previousScores[goalKey].timestamp)),
          currentTime: formatEasternTime(new Date(now))
        });

        if (ageInMinutes > 360 || !isToday(previousScores[goalKey].timestamp)) {
          console.log(`Force removing old goal ${goalKey}:`, {
            ageInMinutes,
            timestamp: formatEasternTime(new Date(previousScores[goalKey].timestamp))
          });
          delete previousScores[goalKey];
        }
      }

      const goalMinute = goal.time.split(':')[0];
      const goalPeriod = goal.period;
      
      // Check for existing goals that are the same except for seconds
      const isDuplicate = Object.entries(previousScores).some(([key, value]) => {
        if (key.startsWith(gameId) && value.posted && isToday(value.timestamp)) {
          const prevGoal = value.goal;
          const prevMinute = prevGoal.time.split(':')[0];
          
          const isDup = prevGoal.period === goalPeriod && 
                       prevMinute === goalMinute && 
                       prevGoal.scorer === goal.scorer &&
                       prevGoal.rawScores.away === goal.rawScores.away &&
                       prevGoal.rawScores.home === goal.rawScores.home;

          if (isDup) {
            console.log(`Found duplicate match with existing goal:`, {
              existingKey: key,
              existingTime: formatEasternTime(new Date(value.timestamp)),
              currentTime: formatEasternTime(new Date(now))
            });
          }
          
          return isDup;
        }
        return false;
      });

      if (isDuplicate) {
        console.log(`Skipping duplicate goal/time update:`, {
          period: goalPeriod,
          minute: goalMinute,
          scorer: goal.scorer,
          score: `${goal.rawScores.away}-${goal.rawScores.home}`,
          timestamp: formatEasternTime(new Date(now))
        });
        return;
      }

      console.log(`Processing goal with key: ${goalKey}`, {
        exists: !!previousScores[goalKey],
        updateCount: previousScores[goalKey]?.updateCount || 0,
        isPosted: previousScores[goalKey]?.posted || false,
        timestamp: previousScores[goalKey]?.timestamp ? 
          formatEasternTime(new Date(previousScores[goalKey].timestamp)) : null,
        currentTime: formatEasternTime(new Date(now))
      });

      if (!previousScores[goalKey]) {
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

          if (updatedGoalPlay && !previousScores[goalKey]?.posted) {
            const message = formatGoalMessage(goal, teams);
            console.log("Attempting to post new goal message:", message);

            try {
              console.log("Making Bluesky API call for new goal...");
              let postResponse = await bot.post({ text: message });
              
              // If post fails, try renewing connection once
              if (!postResponse?.uri) {
                console.log("Post failed - attempting to renew connection");
                if (await renewBotConnection()) {
                  postResponse = await bot.post({ text: message });
                }
              }

              console.log("Bluesky API response:", { uri: postResponse?.uri });
              
              if (postResponse?.uri) {
                console.log(`Successfully posted goal ${goalKey} to Bluesky`, {
                  uri: postResponse.uri,
                  timeET: formatEasternTime(new Date(now))
                });
                
                previousScores[goalKey].posted = true;
                previousScores[goalKey].timestamp = now;
              } else {
                console.error("No URI in Bluesky response - post may have failed");
              }
              
              await delay(config.POST_DELAY);
            } catch (postError) {
              console.error("Bluesky posting error:", getErrorInfo(postError));
              // Leave in previousScores but marked as unposted to retry
              previousScores[goalKey].posted = false;
            }
          } else {
            console.log(`Goal ${goalKey} was either already posted or no longer exists`);
            delete previousScores[goalKey];
          }
        } catch (error) {
          console.error(`Error verifying goal ${goalKey}:`, getErrorInfo(error));
          delete previousScores[goalKey];
        }
      } else if (!previousScores[goalKey].posted) {
        console.log(`Attempting to post previously unposted goal ${goalKey}`);
        const message = formatGoalMessage(goal, teams);
        console.log("Attempting to post message for unposted goal:", message);

        try {
          console.log("Making Bluesky API call for unposted goal...");
          let postResponse = await bot.post({ text: message });
          
          // If post fails, try renewing connection once
          if (!postResponse?.uri) {
            console.log("Post failed - attempting to renew connection");
            if (await renewBotConnection()) {
              postResponse = await bot.post({ text: message });
            }
          }

          console.log("Bluesky API response:", { uri: postResponse?.uri });
          
          if (postResponse?.uri) {
            console.log(`Successfully posted unposted goal ${goalKey} to Bluesky`, {
              uri: postResponse.uri,
              timeET: formatEasternTime(new Date(now))
            });
            
            previousScores[goalKey].posted = true;
            previousScores[goalKey].timestamp = now;
          } else {
            console.error("No URI in Bluesky response - post may have failed");
          }
          
          await delay(config.POST_DELAY);
        } catch (postError) {
          console.error("Bluesky posting error:", getErrorInfo(postError));
          // Leave in previousScores but marked as unposted to retry
          previousScores[goalKey].posted = false;
        }
      } else if (previousScores[goalKey].posted && 
                 previousScores[goalKey].updateCount < config.MAX_UPDATES && 
                 isToday(previousScores[goalKey].timestamp)) {
        previousScores[goalKey].updateCount++;
        const previousGoal = previousScores[goalKey].goal;
        const updatedFields = getUpdatedFields(goal, previousGoal);

        if (updatedFields.length > 0) {
          let message = 'CORRECTION: ';
          if (updatedFields.includes('scorer')) {
            message += `Goal now credited to ${goal.scorer} (previously ${previousGoal.scorer})\n`;
          }
          message += `${teams.away} vs. ${teams.home}\n`;
          if (goal.assists) {
            message += `Assists: ${goal.assists}\n`;
          }
          message += `Time: ${goal.time} - ${goal.period}\n`;
          message += `Score: ${goal.score}`;

          try {
            console.log("Making Bluesky API call for goal update...");
            let postResponse = await bot.post({ text: message });
            
            // If post fails, try renewing connection once
            if (!postResponse?.uri) {
              console.log("Post failed - attempting to renew connection");
              if (await renewBotConnection()) {
                postResponse = await bot.post({ text: message });
              }
            }

            console.log("Bluesky API response:", { uri: postResponse?.uri });
            
            if (postResponse?.uri) {
              console.log(`Successfully posted goal update to Bluesky`, {
                uri: postResponse.uri,
                timeET: formatEasternTime(new Date(now))
              });
              
              previousScores[goalKey].goal = goal;
              previousScores[goalKey].timestamp = now;
            } else {
              console.error("No URI in Bluesky response - post may have failed");
            }
          } catch (postError) {
            console.error("Bluesky posting error:", getErrorInfo(postError));
          }
        }
      } else {
        console.log(`Skipping goal ${goalKey}:`, {
          reason: previousScores[goalKey]?.posted ? 'already posted and processed' : 'unhandled state',
          isPosted: previousScores[goalKey]?.posted || false,
          updates: previousScores[goalKey]?.updateCount || 0,
          age: Math.round((now - previousScores[goalKey].timestamp) / (1000 * 60)) + ' minutes',
          timestamp: previousScores[goalKey]?.timestamp ? formatEasternTime(new Date(previousScores[goalKey].timestamp)) : null
        });
      }
    } finally {
      clearPostingLock(goalKey);
    }
  } catch (error) {
    console.error(`Error in handleGoalUpdate for game ${gameId}:`, getErrorInfo(error));
    clearPostingLock(goalKey);
  }
}

async function startBot() {
  // Clear previousScores at startup
  previousScores = {};
  global.lastMemoryReset = Date.now();
  console.log('Cleared previous scores at startup:', formatEasternTime(new Date()));
 
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
          const now = Date.now();
          const lastReset = global.lastMemoryReset || 0;
          
          // Force memory clear at the start of each day in ET
          if (!isToday(lastReset)) {
            console.log('New day detected in ET, clearing all previous scores', {
              lastResetTime: formatEasternTime(new Date(lastReset)),
              currentTime: formatEasternTime(new Date(now))
            });
            previousScores = {};
            global.lastMemoryReset = now;
          }
 
          console.log("Fetching NHL scores at", formatEasternTime(new Date(now)));
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
        } catch (error) {
          console.error('Error in poll cycle:', error.message);
          if (error.message.includes('Failed to fetch') || 
              error.message.includes('Upstream') || 
              error.status === 502) {
            console.log('Connection issue detected, restarting bot...');
            throw error;
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