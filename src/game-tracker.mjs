/**
 * Tracks which games have been seen LIVE so the poll loop can run one final
 * sweep when a game drops out of the live list.
 *
 * Why: the bot only processes LIVE games, but the NHL API records last-second
 * goals (late regulation, OT winners) right as the game state flips away
 * from LIVE. Without a final sweep those goals are never processed.
 */

export class GameTracker {
  constructor() {
    /** Game ids seen LIVE on the most recent poll. */
    this.recentlyLive = new Set();
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
    return ended;
  }
}
