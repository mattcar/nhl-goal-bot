import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameTracker } from '../src/game-tracker.mjs';

describe('GameTracker', () => {
  it('reports nothing on the first poll and remembers live games', () => {
    const tracker = new GameTracker();
    assert.deepEqual(tracker.endedGames([1, 2]), []);
    assert.deepEqual(tracker.endedGames([1, 2]), []);
  });

  it('reports games that dropped out of the live list exactly once', () => {
    const tracker = new GameTracker();
    tracker.endedGames([1, 2, 3]);
    assert.deepEqual(tracker.endedGames([1, 3]), [2]);
    // Second poll: already swept, not reported again.
    assert.deepEqual(tracker.endedGames([1, 3]), []);
    assert.deepEqual(tracker.endedGames([]), [1, 3]);
    assert.deepEqual(tracker.endedGames([]), []);
  });

  it('never reports a game that is still live', () => {
    const tracker = new GameTracker();
    tracker.endedGames([7]);
    tracker.endedGames([7, 8]);
    assert.deepEqual(tracker.endedGames([7, 8]), []);
  });

  it('re-tracks a game that goes live again after ending', () => {
    const tracker = new GameTracker();
    tracker.endedGames([5]);
    assert.deepEqual(tracker.endedGames([]), [5]);
    // Game 5 shows up live again (e.g. schedule API flakiness).
    assert.deepEqual(tracker.endedGames([5]), []);
    // And is reported again if it ends a second time.
    assert.deepEqual(tracker.endedGames([]), [5]);
  });

  it('handles an empty live list on the first poll', () => {
    const tracker = new GameTracker();
    assert.deepEqual(tracker.endedGames([]), []);
  });
});

describe('GameTracker persistence', () => {
  const NOON_ET = new Date('2026-09-21T12:00:00-04:00').getTime();
  const FOUR_HOURS = 4 * 3600 * 1000;
  const makeSnapshot = (recentlyLive, updatedAt) => ({ recentlyLive, updatedAt });

  it('round-trips the live set through toJSON/fromSnapshot', () => {
    const tracker = new GameTracker();
    tracker.endedGames([1, 2]);
    const json = tracker.toJSON();
    assert.deepEqual(new Set(json.recentlyLive), new Set([1, 2]));
    assert.ok(Number.isFinite(json.updatedAt));

    const restored = GameTracker.fromSnapshot(
      { recentlyLive: json.recentlyLive, updatedAt: NOON_ET - 60_000 },
      { maxAgeMs: FOUR_HOURS, now: NOON_ET },
    );
    // Game 2 ended while "down"; game 1 still live.
    assert.deepEqual(restored.endedGames([1]), [2]);
  });

  it('starts empty when there is no snapshot', () => {
    const restored = GameTracker.fromSnapshot(undefined, {
      maxAgeMs: FOUR_HOURS,
      now: NOON_ET,
    });
    assert.deepEqual(restored.endedGames([1]), []);
  });

  it('discards snapshots older than maxAgeMs', () => {
    const restored = GameTracker.fromSnapshot(makeSnapshot([1, 2], NOON_ET - 5 * 3600 * 1000), {
      maxAgeMs: FOUR_HOURS,
      now: NOON_ET,
    });
    assert.deepEqual(restored.endedGames([]), []);
  });

  it('discards snapshots from a previous ET day', () => {
    // 11:55pm ET yesterday: within maxAge, but goal records from yesterday
    // are pruned at midnight, so sweeping would repost old goals.
    const lateNight = new Date('2026-09-20T23:55:00-04:00').getTime();
    const morning = new Date('2026-09-21T00:05:00-04:00').getTime();
    const restored = GameTracker.fromSnapshot(makeSnapshot([1], lateNight), {
      maxAgeMs: FOUR_HOURS,
      now: morning,
    });
    assert.deepEqual(restored.endedGames([]), []);
  });

  it('discards future and malformed snapshots', () => {
    const bad = [
      null,
      {},
      { recentlyLive: [1] },
      { recentlyLive: [1], updatedAt: 'yesterday' },
      { recentlyLive: 'nope', updatedAt: NOON_ET },
      { recentlyLive: [1], updatedAt: NOON_ET + 60_000 },
    ];
    for (const badSnapshot of bad) {
      const restored = GameTracker.fromSnapshot(badSnapshot, {
        maxAgeMs: FOUR_HOURS,
        now: NOON_ET,
      });
      assert.deepEqual(
        restored.endedGames([1]),
        [],
        `snapshot: ${JSON.stringify(badSnapshot)}`,
      );
    }
  });
});
