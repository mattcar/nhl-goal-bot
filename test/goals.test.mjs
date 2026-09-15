import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGoals,
  goalKey,
  isSameGoal,
  changedFields,
  formatGoalMessage,
  formatCorrectionMessage,
  playerName,
} from '../src/goals.mjs';

const fixture = {
  homeTeam: { id: 1, abbrev: 'CHI' },
  awayTeam: { id: 2, abbrev: 'DET' },
  rosterSpots: [
    {
      playerId: 100,
      firstName: { default: 'Connor' },
      lastName: { default: 'Bedard' },
      sweaterNumber: 98,
    },
    {
      playerId: 101,
      firstName: { default: 'Seth' },
      lastName: { default: 'Jones' },
      sweaterNumber: 4,
    },
  ],
  plays: [
    {
      eventId: 900,
      typeDescKey: 'goal',
      timeInPeriod: '04:32',
      periodDescriptor: { number: 1, periodType: 'REG' },
      details: {
        scoringPlayerId: 100,
        eventOwnerTeamId: 1,
        awayScore: 0,
        homeScore: 1,
        assists: [{ playerId: 101 }],
      },
    },
    {
      eventId: 901,
      typeDescKey: 'shot-on-goal',
      timeInPeriod: '05:10',
      periodDescriptor: { number: 1, periodType: 'REG' },
      details: { scoringPlayerId: 100, eventOwnerTeamId: 1, awayScore: 0, homeScore: 1 },
    },
    {
      eventId: 902,
      typeDescKey: 'goal',
      timeInPeriod: '02:11',
      periodDescriptor: { number: 3, periodType: 'OT' },
      details: {
        scoringPlayerId: 999, // not on roster
        eventOwnerTeamId: 2,
        awayScore: 1,
        homeScore: 1,
      },
    },
  ],
};

describe('extractGoals', () => {
  it('parses goal plays and skips non-goals', () => {
    const goals = extractGoals(fixture);
    assert.equal(goals.length, 2);
    const [first, ot] = goals;
    assert.equal(first.eventId, 900);
    assert.equal(first.scorer, 'Connor Bedard (#98)');
    assert.equal(first.assists, 'Seth Jones (#4)');
    assert.equal(first.time, '04:32');
    assert.equal(first.period, 1);
    assert.equal(first.team, 'CHI');
    assert.equal(first.score, '0 - 1');
    assert.equal(ot.period, 'OT');
    assert.equal(ot.team, 'DET');
  });

  it('falls back to Unknown Player for missing roster entries', () => {
    const [, ot] = extractGoals(fixture);
    assert.equal(ot.scorer, 'Unknown Player');
  });

  it('handles empty input', () => {
    assert.deepEqual(extractGoals({}), []);
    assert.deepEqual(extractGoals(null), []);
  });
});

describe('goal identity', () => {
  const goal = extractGoals(fixture)[0];

  it('goalKey is stable and game-scoped', () => {
    assert.equal(goalKey(2024020001, goal), '2024020001:900');
    assert.notEqual(goalKey(2024020002, goal), goalKey(2024020001, goal));
  });

  it('isSameGoal matches on eventId', () => {
    assert.ok(isSameGoal(goal, { ...goal, scorer: 'Somebody Else' }));
  });

  it('isSameGoal fuzzy-matches a re-issued event id', () => {
    const reissued = { ...goal, eventId: 12345 };
    assert.ok(isSameGoal(goal, reissued));
  });

  it('isSameGoal rejects different goals', () => {
    const other = { ...goal, eventId: 777, scorer: 'Other Guy (#1)' };
    assert.ok(!isSameGoal(goal, other));
  });
});

describe('changedFields', () => {
  it('detects scorer and assist changes', () => {
    const goal = extractGoals(fixture)[0];
    const updated = { ...goal, scorer: 'Seth Jones (#4)', assists: '' };
    assert.deepEqual(changedFields(goal, updated), ['scorer', 'assists']);
  });

  it('returns empty for identical goals', () => {
    const goal = extractGoals(fixture)[0];
    assert.deepEqual(changedFields(goal, { ...goal }), []);
  });
});

describe('message formatting', () => {
  const teams = { home: 'CHI', away: 'DET' };
  const goal = extractGoals(fixture)[0];

  it('formats a goal announcement', () => {
    const msg = formatGoalMessage(goal, teams);
    assert.match(msg, /GOAL! 🚨/);
    assert.match(msg, /DET vs\. CHI/);
    assert.match(msg, /Connor Bedard \(#98\) \(CHI\) is the scorer!/);
    assert.match(msg, /Assists: Seth Jones \(#4\)/);
    assert.match(msg, /Time: 04:32 - 1/);
    assert.match(msg, /Score: 0 - 1/);
  });

  it('formats a correction', () => {
    const corrected = { ...goal, scorer: 'Seth Jones (#4)' };
    const msg = formatCorrectionMessage(corrected, goal, teams);
    assert.match(msg, /^CORRECTION: /);
    assert.match(msg, /now credited to Seth Jones \(#4\) \(previously Connor Bedard \(#98\)\)/);
  });
});

describe('playerName', () => {
  it('handles missing players and numbers', () => {
    assert.equal(playerName(null), 'Unknown Player');
    assert.equal(
      playerName({ firstName: { default: 'A' }, lastName: { default: 'B' } }),
      'A B',
    );
  });
});
