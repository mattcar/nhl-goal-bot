/**
 * Tracks which games have been seen LIVE so the poll loop can run one final
 * sweep when a game drops out of the live list.
 *
 * Why: the bot only processes LIVE games, but the NHL API records last-second
 * goals (late regulation, OT winners) right as the game state flips away
 * from LIVE. Without a final sweep those goals are never processed.
 *
 * The live set is serializable so a restart doesn't lose it: if the process
 * restarts while a game is ending, the restored tracker still triggers the
 * final sweep for that game.
 */

import { isSameETDay } from './time.mjs';

export class GameTracker {
  constructor() {
    /** Game ids seen LIVE on the most recent poll. */
    this.recentlyLive = new Set();
    /** When the live set was last refreshed (ms epoch). */
    this.updatedAt = Date.now();
  }

  /**
   * Given the ids currently LIVE, return ids that were live on the previous
   * poll but are not anymore (presumed just ended). Each ended id is
   * reported exactly once; the live set is replaced for the next call.
   */
  endedGames(liveIds) {
    const live = new Set(liveIds);
    const ended = [...this.recentlyLive].filter((id) => !live.has(id));
    this.recentlyLive = live;
    this.updatedAt = Date.now();
    return ended;
  }

  /** Serializable snapshot of the live set, for the durable store. */
  toJSON() {
    return { recentlyLive: [...this.recentlyLive], updatedAt: this.updatedAt };
  }

  /**
   * Rebuild a tracker from a snapshot (or start empty when there is none).
   *
   * Stale snapshots are discarded: after a long downtime, the goal records a
   * final sweep would consult may already have been pruned, and sweeping
   * those games would repost old goals. A snapshot is fresh only when it is
   * younger than maxAgeMs and from the same ET day — the two conditions on
   * which goal records are pruned.
   */
  static fromSnapshot(snapshot, { maxAgeMs, now = Date.now() } = {}) {
    const tracker = new GameTracker();
    const age = snapshot ? now - snapshot.updatedAt : NaN;
    const fresh =
      snapshot &&
      Array.isArray(snapshot.recentlyLive) &&
      Number.isFinite(maxAgeMs) &&
      age >= 0 &&
      age <= maxAgeMs &&
      isSameETDay(snapshot.updatedAt, now);
    if (fresh) {
      tracker.recentlyLive = new Set(snapshot.recentlyLive);
      tracker.updatedAt = snapshot.updatedAt;
    }
    return tracker;
  }
}
