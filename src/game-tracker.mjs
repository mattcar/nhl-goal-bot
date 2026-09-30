/**
 * Tracks which games have been seen LIVE so the poll loop can run a final
 * sweep when a game drops out of the live list — plus re-sweeps for games
 * that ended recently.
 *
 * Why: the bot only processes LIVE games, but the NHL API records last-second
 * goals (late regulation, OT winners) right as the game state flips away
 * from LIVE, and on busy nights the API can take several more minutes to
 * record them. A single sweep at the final horn misses those goals, so ended
 * games stay eligible for re-sweeps for a configurable window. Re-sweeping
 * is safe: posted goals are never posted twice.
 *
 * The live set is serializable so a restart doesn't lose it: if the process
 * restarts while a game is ending, the restored tracker still triggers the
 * final sweep for that game.
 */

import { isSameETDay } from './time.mjs';

/** Default re-sweep window: keep sweeping ended games for 20 minutes. */
export const DEFAULT_SWEEP_WINDOW_MS = 20 * 60 * 1000;

export class GameTracker {
  constructor({ sweepWindowMs = DEFAULT_SWEEP_WINDOW_MS } = {}) {
    /** Game ids seen LIVE on the most recent poll. */
    this.recentlyLive = new Set();
    /** Game ids that ended recently: id -> ms epoch when first seen ended. */
    this.recentlyEnded = new Map();
    /** When the live set was last refreshed (ms epoch). */
    this.updatedAt = Date.now();
    /** How long after a game ends it stays eligible for re-sweeps. */
    this.sweepWindowMs = sweepWindowMs;
  }

  /**
   * Given the ids currently LIVE, return ids that were live on the previous
   * poll but are not anymore (presumed just ended). Each ended id is
   * reported exactly once; the live set is replaced for the next call.
   * Newly ended games are stamped into the recently-ended set so
   * gamesToSweep() can re-sweep them while the NHL API catches up.
   */
  endedGames(liveIds, { now = Date.now() } = {}) {
    const live = new Set(liveIds);
    const ended = [...this.recentlyLive].filter((id) => !live.has(id));
    this.recentlyLive = live;
    this.updatedAt = now;
    for (const id of ended) {
      if (!this.recentlyEnded.has(id)) this.recentlyEnded.set(id, now);
    }
    // A game seen live again (e.g. schedule API flakiness) leaves the
    // recently-ended set; if it ends again it gets a fresh timestamp.
    for (const id of live) this.recentlyEnded.delete(id);
    return ended;
  }

  /**
   * Ids to sweep on this poll: newly ended games plus games that ended
   * within the sweep window. Games whose window expired are dropped.
   */
  gamesToSweep(liveIds, { now = Date.now() } = {}) {
    this.endedGames(liveIds, { now });
    const targets = [];
    for (const [id, endedAt] of this.recentlyEnded) {
      if (now - endedAt <= this.sweepWindowMs) targets.push(id);
      else this.recentlyEnded.delete(id);
    }
    return targets;
  }

  /** Serializable snapshot of the live set, for the durable store. */
  toJSON() {
    return {
      recentlyLive: [...this.recentlyLive],
      recentlyEnded: [...this.recentlyEnded],
      updatedAt: this.updatedAt,
    };
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
  static fromSnapshot(snapshot, { maxAgeMs, sweepWindowMs, now = Date.now() } = {}) {
    const tracker = new GameTracker({ sweepWindowMs });
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
      const ended = snapshot.recentlyEnded;
      tracker.recentlyEnded = new Map(
        Array.isArray(ended)
          ? ended.filter((e) => Array.isArray(e) && e.length === 2)
          : [],
      );
      tracker.updatedAt = snapshot.updatedAt;
    }
    return tracker;
  }
}
