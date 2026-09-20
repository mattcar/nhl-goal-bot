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
