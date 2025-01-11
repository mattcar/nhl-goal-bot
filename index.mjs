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

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return hash;
}

function cleanupOldScores() {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  Object.keys(previousScores).forEach(key => {
    if (previousScores[key].timestamp < oneDayAgo) {
      delete previousScores[key];
    }
  });
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
      score: `${data.awayTeam.score} - ${data.homeTeam.score}`,
    };
  } catch (error) {
    console.error("Error processing goal play:", error.message);
    return null;
  }
}

async function handleGoalUpdate(gameId, goal, teams) {
  try {
    const goalKey = `${gameId}-${goal.eventId}-${goal.scorer}-${goal.time.substring(0, 5)}-${goal.period}-${goal.team}-${goal.score}`;

    if (!previousScores[goalKey]) {
      console.log("New goal detected:", safeStringify(goal));

      await delay(config.INITIAL_DELAY);

      try {
        const updatedData = await fetchGamePlayByPlay(gameId);
        const updatedGoalPlay = updatedData.plays.find(play => play.eventId === goal.eventId);

        if (updatedGoalPlay) {
          const updatedGoal = processGoalPlay(updatedGoalPlay, updatedData);
          if (!updatedGoal) {
            console.error("Failed to process updated goal");
            return;
          }

          const message = formatGoalMessage(updatedGoal, teams);
          console.log("Attempting to post message:", message);

          try {
            await bot.post({ text: message });
            console.log("Successfully posted goal to Bluesky");
          } catch (error) {
            console.error("Error posting to Bluesky:", error.message);
            return;
          }

          previousScores[goalKey] = {
            goal: updatedGoal,
            updateCount: 0,
            hash: hashCode(safeStringify(updatedGoal)),
            timestamp: Date.now()
          };

          await delay(config.POST_DELAY);
        } else {
          console.log("Goal no longer found in updated data");
        }
      } catch (error) {
        console.error("Error processing goal update:", error.message);
      }
    } else {
      previousScores[goalKey].updateCount++;

      if (previousScores[goalKey].updateCount <= config.MAX_UPDATES) {
        const previousGoal = previousScores[goalKey].goal;
        const updatedFields = getUpdatedFields(goal, previousGoal);

        if (updatedFields.length > 0) {
          const message = formatGoalMessage(goal, teams, true);
          try {
            await bot.post({ text: message });
            console.log("Successfully posted goal update to Bluesky");
            previousScores[goalKey].goal = goal;
          } catch (error) {
            console.error("Error posting update to Bluesky:", error.message);
          }
        }
      }
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
  try {
    await bot.login({
      identifier: 'nhl-goal-bot.bsky.social',
      password: process.env.BLUESKY_PASSWORD
    });

    console.log('Bot successfully logged in');

    const pollGames = async () => {
      try {
        console.log("Fetching NHL scores at", new Date().toISOString());
        const scheduleData = await fetchNHLSchedule();

        const liveGameIds = scheduleData.gameWeek.flatMap(week =>
          week.games.filter(game => game.gameState === 'LIVE').map(game => game.id)
        );

        console.log("Live game IDs:", liveGameIds);

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
      }
    };

    setInterval(pollGames, config.POLL_INTERVAL);
    pollGames(); // Initial poll
  } catch (error) {
    console.error('Error logging in:', error.message);
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