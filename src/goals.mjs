/**
 * Goal extraction, identity, and message formatting.
 * Pure functions — no I/O — so they're easy to unit test.
 */

export function playerName(player) {
  if (!player) return 'Unknown Player';
  const first = player.firstName?.default ?? '';
  const last = player.lastName?.default ?? '';
  const name = `${first} ${last}`.trim();
  const number = player.sweaterNumber != null ? ` (#${player.sweaterNumber})` : '';
  return name ? `${name}${number}` : 'Unknown Player';
}

function parseGoalPlay(play, rosterById, homeTeam, awayTeam) {
  const details = play.details;
  if (!details) return null;

  const scorer = rosterById.get(details.scoringPlayerId);
  const assists = (details.assists ?? [])
    .map((assist) => playerName(rosterById.get(assist.playerId)))
    .join(', ');

  const scoringTeam =
    details.eventOwnerTeamId === homeTeam.id ? homeTeam.abbrev : awayTeam.abbrev;

  const periodDescriptor = play.periodDescriptor ?? {};
  const period =
    periodDescriptor.periodType === 'REG' ? periodDescriptor.number : periodDescriptor.periodType;

  return {
    eventId: play.eventId,
    scorer: playerName(scorer),
    assists,
    time: play.timeInPeriod,
    period,
    team: scoringTeam || 'Unknown Team',
    score: `${details.awayScore} - ${details.homeScore}`,
    awayScore: details.awayScore,
    homeScore: details.homeScore,
  };
}

/** Every goal play in a play-by-play payload, as plain goal objects. */
export function extractGoals(playByPlay) {
  const { plays = [], rosterSpots = [], homeTeam = {}, awayTeam = {} } = playByPlay ?? {};
  const rosterById = new Map(rosterSpots.map((p) => [p.playerId, p]));
  return plays
    .filter((play) => play.typeDescKey === 'goal' && play.details?.scoringPlayerId)
    .map((play) => parseGoalPlay(play, rosterById, homeTeam, awayTeam))
    .filter(Boolean);
}

/** Stable identity for a goal: the NHL's event id, scoped to the game. */
export function goalKey(gameId, goal) {
  return `${gameId}:${goal.eventId}`;
}

/**
 * Fuzzy identity for when the NHL re-issues an event id for the same goal
 * (e.g. after a scoring correction). Same game, period, minute, scorer, score.
 */
export function isSameGoal(a, b) {
  if (a.eventId != null && a.eventId === b.eventId) return true;
  const minute = (t) => String(t ?? '').split(':')[0];
  return (
    a.period === b.period &&
    minute(a.time) === minute(b.time) &&
    a.scorer === b.scorer &&
    a.awayScore === b.awayScore &&
    a.homeScore === b.homeScore
  );
}

/** Field names whose values changed between two snapshots of a goal. */
export function changedFields(oldGoal, newGoal) {
  const fields = [];
  for (const field of ['scorer', 'assists', 'period', 'score']) {
    if (oldGoal[field] !== newGoal[field]) fields.push(field);
  }
  return fields;
}

export function formatGoalMessage(goal, teams) {
  let message = 'GOAL! 🚨\n';
  message += `${teams.away} vs. ${teams.home}\n`;
  message += `${goal.scorer} (${goal.team}) is the scorer!`;
  if (goal.assists) {
    message += `\nAssists: ${goal.assists}`;
  }
  message += `\nTime: ${goal.time} - ${goal.period}`;
  message += `\nScore: ${goal.score}`;
  return message;
}

export function formatCorrectionMessage(goal, previousGoal, teams) {
  let message = 'CORRECTION: ';
  if (goal.scorer !== previousGoal.scorer) {
    message += `Goal now credited to ${goal.scorer} (previously ${previousGoal.scorer})\n`;
  }
  message += `${teams.away} vs. ${teams.home}\n`;
  if (goal.assists) {
    message += `Assists: ${goal.assists}\n`;
  }
  message += `Time: ${goal.time} - ${goal.period}\n`;
  message += `Score: ${goal.score}`;
  return message;
}
