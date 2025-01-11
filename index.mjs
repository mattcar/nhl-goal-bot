import fetch from 'node-fetch';
import { Bot } from '@skyware/bot';
import http from 'http'; 

globalThis.fetch = fetch;
globalThis.Headers = fetch.Headers;

const bot = new Bot(); 

let previousScores = {};

async function startBot() {
  try {
    await bot.login({
      identifier: 'nhl-goal-bot.bsky.social',
      password: process.env.BLUESKY_PASSWORD 
    });

    console.log('Bot logged in!');

    while (true) {
      console.log("Fetching NHL scores at", new Date());
      await fetchNHLScores();
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  } catch (error) {
    console.error('Error logging in or fetching scores:', error);
  }
}

async function fetchNHLScores() {
  try {
    const scheduleResponse = await fetch('https://api-web.nhle.com/v1/schedule/now');
    const scheduleData = await scheduleResponse.json();

    const liveGameIds = scheduleData.gameWeek.flatMap(week =>
      week.games.filter(game => game.gameState === 'LIVE').map(game => game.id)
    );

    console.log("Live game IDs:", liveGameIds); 

    for (const gameId of liveGameIds) {
      try {
        const response = await fetch(`https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`);

        console.log(`Fetch response status for game ${gameId}:`, response.status, response.statusText);

        const contentType = response.headers.get('Content-Type');
        if (!contentType || !contentType.includes('application/json')) {
          console.error(`Error: Unexpected Content-Type for play-by-play data ${gameId}: ${contentType}`);
          const responseText = await response.text();
          console.log(responseText);
          continue;
        }

        const data = await response.json();

        // Data validation: Check for 'plays' array
        if (!Array.isArray(data.plays)) {
          console.error("Error: 'plays' array not found in API response:", data);
          continue; 
        }

        console.log("Filtering for goals...");

        const newGoals = data.plays
          .filter(play => {
            const isGoal = play.typeDescKey === 'goal' && play.details?.scoringPlayerId;
            if (isGoal) {
              console.log("Goal play found:", play); 
            }
            return isGoal;
          })
          .map(play => {
            try {
              // Data validation: Check play.details structure
              if (!play.details) {
                console.error("Error: Invalid 'play.details' structure:", play);
                return null;
              }

              const { scoringPlayerId, eventOwnerTeamId } = play.details;

              const scorer = data.rosterSpots.find(player => player.playerId === scoringPlayerId);

              // Handle multiple assists
              const assists = (play.details.assists || [])
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
                assists: assists, // Include all assists
                time: play.timeInPeriod,
                // Handle playoff period formatting
                period: play.periodDescriptor.periodType === 'REGULAR' 
                        ? play.periodDescriptor.number 
                        : play.periodDescriptor.periodType, 
                team: scoringTeam || 'Unknown Team',
                score: `${data.awayTeam.score} - ${data.homeTeam.score}`,
              };
            } catch (error) {
              console.error("Error mapping goal play:", error, play);
              return null;
            }
          })
          .filter(goal => goal !== null);

        console.log("New goals:", newGoals); 

        for (const goal of newGoals) {
          const goalKey = `${gameId}-${goal.eventId}-${goal.scorer}-${goal.time}-${goal.period}-${goal.team}-${goal.score}`;

          let goalMessage;

          if (!previousScores[goalKey]) {
            console.log("New goal detected!", goal);

            goalMessage = `GOAL! 🚨\n${data.awayTeam.abbrev} vs. ${data.homeTeam.abbrev}\n`;
            goalMessage += `${goal.scorer} (${goal.team}) scores!`;
            if (goal.assists) {
              goalMessage += `\nAssists: ${goal.assists}`;
            }
            goalMessage += `\nTime: ${goal.time} - ${goal.period}`;
            goalMessage += `\nScore: ${goal.score}`; 

            try {
              console.log("Attempting to post to Bluesky:", goalMessage);
              const postResponse = await bot.post({ text: goalMessage });
              console.log("Bluesky post response:", postResponse); 
            } catch (error) {
              console.error("Error posting to Bluesky:", error);
            }

            // Initialize goal data with update count
            previousScores[goalKey] = { goal: goal, updateCount: 0 }; 

            // Introduce a delay of 3 minutes before checking for updates
            await new Promise(resolve => setTimeout(resolve, 180000)); 

          } else {
            previousScores[goalKey].updateCount++;

            // Allow up to 2 updates
            if (previousScores[goalKey].updateCount <= 2) { 
              const previousGoal = previousScores[goalKey].goal;

              let updateMessage = "UPDATE: ";
              const updatedFields = [];
              if (goal.scorer !== previousGoal.scorer) {
                updatedFields.push(`scorer (was ${previousGoal.scorer})`);
              }
              if (goal.assists !== previousGoal.assists) {
                updatedFields.push(`assists (were ${previousGoal.assists || 'none'})`);
              }
              if (goal.time !== previousGoal.time) {
                updatedFields.push(`time (was ${previousGoal.time})`);
              }
              if (goal.period !== previousGoal.period) {
                updatedFields.push(`period (was ${previousGoal.period})`);
              }
              if (goal.score !== previousGoal.score) {
                updatedFields.push(`score (was ${previousGoal.score})`);
              }

              if (updatedFields.length > 0) {
                updateMessage += updatedFields.join(", ");

                goalMessage = `Updated Goal Info:\n${data.awayTeam.abbrev} vs. ${data.homeTeam.abbrev}\n`; 
                goalMessage += `${goal.scorer} (${goal.team}) was the scorer.`; 
                if (goal.assists) {
                  goalMessage += `\nAssists: ${goal.assists}`;
                }
                goalMessage += `\nTime: ${goal.time} - ${goal.period}`;
                goalMessage += `\nScore: ${goal.score}`;
                goalMessage += `\n\n${updateMessage}`;

                try {
                  console.log("Attempting to post to Bluesky:", goalMessage);
                  const postResponse = await bot.post({ text: goalMessage });
                  console.log("Bluesky post response:", postResponse); 
                } catch (error) {
                  console.error("Error posting to Bluesky:", error);
                }

                previousScores[goalKey].goal = goal; 
              }
            }
          }
        } 

      } catch (error) {
        console.error(`Error fetching data for game ${gameId}:`, error);
      }
    }

  } catch (error) {
    console.error('Error fetching NHL schedule:', error);
  }
}

startBot();

const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('NHL Goal Bot is running!');
});

server.listen(port, () => {
  console.log(`NHL Goal Bot listening on port ${port}`);
});