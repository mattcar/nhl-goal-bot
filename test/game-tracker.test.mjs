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

describe('GameTracker re-sweeps', () => {
  const MIN = 60_000;
  const T0 = new Date('2026-09-30T01:00:00-04:00').getTime();
  const WINDOW = 20 * MIN;

  it('sweeps newly ended games', () => {
    const tracker = new GameTracker({ sweepWindowMs: WINDOW });
    tracker.gamesToSweep([1, 2], { now: T0 });
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + MIN }), [2]);
  });

  it('keeps re-sweeping recently ended games within the window', () => {
    const tracker = new GameTracker({ sweepWindowMs: WINDOW });
    tracker.gamesToSweep([1, 2], { now: T0 });
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + MIN }), [2]);
    // Still eligible 19 minutes later.
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + 19 * MIN }), [2]);
  });

  it('drops games whose sweep window expired', () => {
    const tracker = new GameTracker({ sweepWindowMs: WINDOW });
    tracker.gamesToSweep([1, 2], { now: T0 });
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + MIN }), [2]);
    // 21 minutes after the game ended the window has expired.
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + 22 * MIN }), []);
    // And it stays dropped.
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + 23 * MIN }), []);
  });

  it('does not re-sweep games that are live again', () => {
    const tracker = new GameTracker({ sweepWindowMs: WINDOW });
    tracker.gamesToSweep([1, 2], { now: T0 });
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + MIN }), [2]);
    // Game 2 shows up live again (API flakiness): no longer a sweep target.
    assert.deepEqual(tracker.gamesToSweep([1, 2], { now: T0 + 2 * MIN }), []);
    // If it ends again it gets a fresh window.
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + 3 * MIN }), [2]);
    assert.deepEqual(tracker.gamesToSweep([1], { now: T0 + 3 * MIN + WINDOW + 1 }), []);
  });

  it('round-trips recently-ended games through toJSON/fromSnapshot', () => {
    const tracker = new GameTracker({ sweepWindowMs: WINDOW });
    tracker.gamesToSweep([1, 2], { now: T0 });
    tracker.gamesToSweep([1], { now: T0 + MIN });
    const json = tracker.toJSON();

    const restored = GameTracker.fromSnapshot(json, {
      maxAgeMs: 4 * 3600 * 1000,
      sweepWindowMs: WINDOW,
      now: T0 + 2 * MIN,
    });
    // Game 2 ended ~2 minutes ago: still within the re-sweep window.
    assert.deepEqual(restored.gamesToSweep([1], { now: T0 + 2 * MIN }), [2]);
  });

  it('restores an empty recently-ended set from old snapshots', () => {
    const tracker = new GameTracker({ sweepWindowMs: WINDOW });
    tracker.gamesToSweep([1, 2], { now: T0 });
    tracker.gamesToSweep([1], { now: T0 + MIN });
    const json = tracker.toJSON();
    delete json.recentlyEnded;

    const restored = GameTracker.fromSnapshot(json, {
      maxAgeMs: 4 * 3600 * 1000,
      sweepWindowMs: WINDOW,
      now: T0 + 2 * MIN,
    });
    // Old snapshot shape: game 2's end was already reported once, and with
    // no recently-ended data there is nothing left to re-sweep.
    assert.deepEqual(restored.gamesToSweep([1], { now: T0 + 2 * MIN }), []);
  });
});
