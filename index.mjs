import fetch from 'node-fetch';
globalThis.fetch = fetch;
globalThis.Headers = fetch.Headers;

import { Bot } from '@skyware/bot';


const bot = new Bot(); // Keep this line as is

let previousScores = {};

async function startBot() {
  try {
    await bot.login({
      identifier: 'nhl-goal-bot.bsky.social',
      password: process.env.BLUESKY_PASSWORD // Access password from environment variable
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

        const contentType = response.headers.get('Content-Type');
        if (!contentType || !contentType.includes('application/json')) {
          console.error(`Error: Unexpected Content-Type for play-by-play data ${gameId}: ${contentType}`);
          const responseText = await response.text();
          console.log(responseText);
          continue;
        }

        const data = await response.json();

        console.log(`Play-by-play data for game ${gameId}:`, data);

        console.log("Filtering for goals...");

        const newGoals = data.plays
          .filter(play => {
            const isGoal = play.typeDescKey === 'goal' && play.details?.scoringPlayerId;
            console.log(`Checking play with eventId ${play.eventId}: isGoal = ${isGoal}`);
            if (isGoal) {
              console.log("Goal play found:", play);
            }
            return isGoal;
          })
          .map(play => {
            try {
              console.log("Mapping goal play:", play);
              const { scoringPlayerId, assist1PlayerId, eventOwnerTeamId } = play.details;

              const scorer = data.rosterSpots.find(player => player.playerId === scoringPlayerId);
              const assist1 = data.rosterSpots.find(player => player.playerId === assist1PlayerId);

              const scoringTeam = eventOwnerTeamId === data.homeTeam.id
                ? data.homeTeam.abbrev
                : data.awayTeam.abbrev;

              return {
                scorer: scorer ? `${scorer.firstName.default} ${scorer.lastName.default} (#${scorer.sweaterNumber})` : 'Unknown Player',
                assists: assist1 ? `${assist1.firstName.default} ${assist1.lastName.default} (#${assist1.sweaterNumber})` : '',
                time: play.timeInPeriod,
                period: play.periodDescriptor.number,
                team: scoringTeam || 'Unknown Team',
              };
            } catch (error) {
              console.error("Error mapping goal play:", error, play);
              return null;
            }
          })
          .filter(goal => goal !== null);

        console.log("New goals:", newGoals);

        for (const goal of newGoals) {
          const goalKey = `${gameId}-${goal.scorer}-${goal.time}-${goal.period}`;

          if (!previousScores[goalKey]) {
            console.log("New goal detected!", goal);

            let goalMessage = `GOAL! 🚨\n${data.awayTeam.abbrev} vs. ${data.homeTeam.abbrev}\n`;
            goalMessage += `${goal.scorer} (${goal.team}) scores!`;
            if (goal.assists) {
              goalMessage += `\nAssists: ${goal.assists}`;
            }
            goalMessage += `\nTime: ${goal.time} - ${goal.period}`;
            goalMessage += `\nScore: ${data.awayTeam.score} - ${data.homeTeam.score}`;

            await bot.post({ text: goalMessage });
            console.log("Goal notification posted to Bluesky!");

            previousScores[goalKey] = true;
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

app.listen(port, () => {
  console.log(`NHL Goal Bot listening on port ${port}`);
});