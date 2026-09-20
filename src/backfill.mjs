/**
 * Cold-start safety net: if the goal store is empty (e.g. the disk was
 * wiped), rebuild "already posted" state from the bot's own Bluesky feed so
 * a restart mid-game doesn't repost every goal.
 *
 * Uses the public Bluesky API (no auth). Post parsing mirrors
 * formatGoalMessage() in goals.mjs — if that format changes, update the
 * parser and its tests together.
 */

import { goalKey, isSameGoal } from './goals.mjs';

const feedUrl = (actor) =>
  `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=100`;

/** Text of recent top-level posts from the bot's own feed. */
export async function fetchRecentPosts(actor, fetchFn = fetch) {
  const res = await fetchFn(feedUrl(actor));
  if (!res.ok) throw new Error(`Bluesky feed fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.feed ?? [])
    .map((item) => item.post)
    .filter((post) => post && !post.record?.reply)
    .map((post) => post.record?.text)
    .filter(Boolean);
}

const SCORER_RE = /^(.+?)(?: \((#\d+)\))? \(([A-Z]{2,3})\) is the scorer!$/;
const POST_RE =
  /^GOAL! 🚨\n(\S+) vs\. (\S+)\n(.+)\n(?:Assists: .*\n)?Time: (\d{1,2}:\d{2}) - (\S+)\nScore: (\d+) - (\d+)$/;

/**
 * Parse a goal post back into a goal-like object for isSameGoal matching.
 * Returns null for anything that isn't a goal post (corrections, etc.).
 */
export function parseGoalPost(text) {
  const m = POST_RE.exec(text.trim());
  if (!m) return null;
  const [, away, home, scorerLine, time, periodText, awayScore, homeScore] = m;
  const sm = SCORER_RE.exec(scorerLine);
  if (!sm) return null;
  const [, name, number] = sm;
  return {
    away,
    home,
    scorer: number ? `${name} (${number})` : name,
    time,
    // goals.mjs stores REG periods as numbers, OT/SO as strings
    period: /^\d+$/.test(periodText) ? Number(periodText) : periodText,
    awayScore: Number(awayScore),
    homeScore: Number(homeScore),
  };
}

/**
 * Mark goals in currently-live games as posted when they match a recent feed
 * post. `store` needs has/set; `getGames()` resolves to
 * [{ gameId, teams: { away, home }, goals: [...] }].
 * Returns the number of goals seeded. Never throws for parse/match issues —
 * worst case it seeds nothing and the caller continues with an empty store.
 */
export async function seedStoreFromFeed({ store, actor, getGames, fetchFn = fetch }) {
  const parsed = (await fetchRecentPosts(actor, fetchFn)).map(parseGoalPost).filter(Boolean);
  if (parsed.length === 0) return 0;
  const now = Date.now();
  let seeded = 0;
  for (const game of await getGames()) {
    for (const goal of game.goals) {
      const key = goalKey(game.gameId, goal);
      if (store.has(key)) continue;
      const match = parsed.some(
        (p) => p.away === game.teams.away && p.home === game.teams.home && isSameGoal(goal, p),
      );
      if (match) {
        store.set(key, { goal, posted: true, updateCount: 0, firstSeen: now, timestamp: now });
        seeded += 1;
      }
    }
  }
  return seeded;
}
