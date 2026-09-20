/**
 * nhl-goal-bot — polls the NHL API for live games and posts goals to Bluesky.
 *
 * Loop: every POLL_INTERVAL_MS, fetch today's schedule, and for each LIVE
 * game fetch play-by-play and handle every goal play. Each goal is verified
 * (re-fetched after INITIAL_DELAY_MS to catch quick stat corrections),
 * posted once, then watched for corrections up to MAX_UPDATES times.
 * Games that drop out of the live list get one final sweep so end-of-game
 * goals (late regulation, OT winners) are not missed.
 *
 * State persists in GOAL_STORE_PATH so restarts don't repost goals.
 */

import http from 'node:http';
import { loadConfig } from './src/config.mjs';
import { NhlClient } from './src/nhl.mjs';
import {
  extractGoals,
  goalKey,
  isSameGoal,
  changedFields,
  formatGoalMessage,
  formatCorrectionMessage,
} from './src/goals.mjs';
import { GoalStore } from './src/store.mjs';
import { BlueskyPoster } from './src/bluesky.mjs';
import { GameTracker } from './src/game-tracker.mjs';
import { retryForever } from './src/retry.mjs';
import { seedStoreFromFeed } from './src/backfill.mjs';
import { etDayKey, isSameETDay, ageMinutes, formatET } from './src/time.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message, data) => {
  if (data === undefined) console.log(`[${formatET()}] ${message}`);
  else console.log(`[${formatET()}] ${message}`, data);
};

async function main() {
  const config = loadConfig();
  const nhl = new NhlClient(config.apiBaseUrl);
  const poster = new BlueskyPoster({
    identifier: config.blueskyIdentifier,
    password: config.blueskyPassword,
  });
  const store = await new GoalStore(config.storePath).load();

  pruneOldGoals(store, config);
  await store.save();

  // Health reporting starts before anything that can fail and kill the
  // process, so a bad deploy or an upstream outage is visible instead of
  // just a crash loop. 200 = ready, 503 = still starting or degraded.
  const health = {
    state: 'starting', // starting | ready | degraded
    startedAt: Date.now(),
    lastTickAt: null,
    lastTickOk: null,
    goalsPosted: 0,
  };
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({
      status: health.state === 'ready' ? 'ok' : health.state,
      uptimeSec: Math.floor((Date.now() - health.startedAt) / 1000),
      lastTickAt: health.lastTickAt ? new Date(health.lastTickAt).toISOString() : null,
      lastTickOk: health.lastTickOk,
      goalsPosted: health.goalsPosted,
    });
    res.writeHead(health.state === 'ready' ? 200 : 503, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.end(body);
  });
  server.listen(config.port, () => log(`Health check listening on port ${config.port}`));

  // A failed login used to be fatal (exit 1 -> Render restart -> crash loop
  // if Bluesky is down or the password is wrong). Now we stay up and keep
  // retrying with backoff; the health endpoint reports "degraded" meanwhile.
  await retryForever(() => poster.login(), {
    onError: (err, waitMs, attempt) => {
      health.state = 'degraded';
      log(`Bluesky login failed (attempt ${attempt}), retrying in ${Math.round(waitMs / 1000)}s: ${err.message}`);
    },
  });
  health.state = 'ready';

  if (store.size === 0) {
    // Cold start: the disk may have been wiped (or this is a first deploy).
    // Rebuild "already posted" state from our own Bluesky feed so a restart
    // mid-game doesn't repost every goal.
    log('Goal store is empty, attempting backfill from Bluesky feed');
    try {
      const seeded = await seedStoreFromFeed({
        store,
        actor: config.blueskyIdentifier,
        getGames: async () => {
          const games = [];
          const schedule = await nhl.getSchedule();
          for (const gameId of nhl.liveGameIds(schedule)) {
            try {
              const pbp = await nhl.getPlayByPlay(gameId);
              games.push({
                gameId,
                teams: { away: pbp.awayTeam.abbrev, home: pbp.homeTeam.abbrev },
                goals: extractGoals(pbp),
              });
            } catch (err) {
              log(`Backfill: skipping game ${gameId}: ${err.message}`);
            }
          }
          return games;
        },
      });
      if (seeded > 0) await store.save();
      log(`Backfill complete, marked ${seeded} goal(s) as posted`);
    } catch (err) {
      log(`Backfill failed, continuing with empty store: ${err.message}`);
    }
  }

  log('Logged in to Bluesky');

  /** Goal keys currently being handled; the poll loop never awaits these. */
  const inFlight = new Set();

  /** Games seen LIVE, so just-ended games get one final sweep. */
  const gameTracker = new GameTracker();

  /** Exact key hit, else a fuzzy match for a re-issued event id. */
  function findRecord(gameId, goal) {
    const exact = store.get(goalKey(gameId, goal));
    if (exact) return exact;
    for (const [key, record] of store.entries()) {
      if (key.startsWith(`${gameId}:`) && isSameGoal(record.goal, goal)) {
        return record;
      }
    }
    return undefined;
  }

  async function handleGoal(gameId, goal, teams) {
    const key = goalKey(gameId, goal);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const record = findRecord(gameId, goal);

      if (record?.posted) {
        await maybePostCorrection(key, record, goal, teams);
        return;
      }

      let rec = record;
      if (!rec) {
        rec = {
          goal,
          posted: false,
          updateCount: 0,
          firstSeen: Date.now(),
          timestamp: Date.now(),
        };
        store.set(key, rec);
        await store.save();
        log(`New goal ${key}, verifying in ${config.initialDelayMs / 1000}s`);
        await delay(config.initialDelayMs);

        // Re-fetch: skip goals the NHL already took back, and never
        // double-post if another handler got here first.
        const fresh = await nhl.getPlayByPlay(gameId);
        const stillThere = extractGoals(fresh).some((g) => g.eventId === goal.eventId);
        const current = store.get(key);
        if (!stillThere) {
          log(`Goal ${key} vanished on re-check, dropping`);
          store.delete(key);
          await store.save();
          return;
        }
        if (!current || current.posted) return;
        rec = current;
      }

      const response = await poster.post(formatGoalMessage(goal, teams));
      rec.posted = true;
      rec.timestamp = Date.now();
      health.goalsPosted += 1;
      await store.save();
      log(`Posted goal ${key}`, { uri: response.uri });
      await delay(config.postDelayMs);
    } catch (err) {
      log(`Goal handler failed for ${key}: ${err.message}`);
    } finally {
      inFlight.delete(key);
    }
  }

  async function maybePostCorrection(key, record, goal, teams) {
    if (record.updateCount >= config.maxUpdates) return;
    if (!isSameETDay(record.timestamp)) return;
    const fields = changedFields(record.goal, goal);
    if (fields.length === 0) return;

    record.updateCount += 1;
    const response = await poster.post(formatCorrectionMessage(goal, record.goal, teams));
    record.goal = goal;
    record.timestamp = Date.now();
    await store.save();
    log(`Posted correction for ${key}`, { uri: response.uri, fields });
  }

  async function pollGames() {
    const schedule = await nhl.getSchedule();
    const liveIds = nhl.liveGameIds(schedule);
    if (liveIds.length > 0) log('Live games:', liveIds);

    // Final sweep for games that just ended: the NHL API records
    // last-second goals (late regulation, OT winners) right as the game
    // state flips away from LIVE, so without this they would never post.
    for (const gameId of gameTracker.endedGames(liveIds)) {
      try {
        const pbp = await nhl.getPlayByPlay(gameId);
        const teams = { home: pbp.homeTeam.abbrev, away: pbp.awayTeam.abbrev };
        log(`Final sweep for ended game ${gameId}`);
        for (const goal of extractGoals(pbp)) {
          // Fire and forget, same as the live loop below.
          handleGoal(gameId, goal, teams).catch((err) =>
            log(`Goal handler crashed: ${err.message}`),
          );
        }
      } catch (err) {
        log(`Final sweep failed for game ${gameId}: ${err.message}`);
      }
    }

    for (const gameId of liveIds) {
      try {
        const pbp = await nhl.getPlayByPlay(gameId);
        const teams = { home: pbp.homeTeam.abbrev, away: pbp.awayTeam.abbrev };
        for (const goal of extractGoals(pbp)) {
          // Fire and forget: slow per-goal delays must not stall the poll loop.
          handleGoal(gameId, goal, teams).catch((err) =>
            log(`Goal handler crashed: ${err.message}`),
          );
        }
      } catch (err) {
        log(`Skipping game ${gameId}: ${err.message}`);
      }
    }
  }

  // Prune once per ET day, then poll.
  let lastDay = etDayKey();
  async function tick() {
    try {
      const today = etDayKey();
      if (today !== lastDay) {
        lastDay = today;
        const removed = pruneOldGoals(store, config);
        await store.save();
        log(`New ET day, pruned ${removed} old goal record(s)`);
      }
      await pollGames();
      health.lastTickAt = Date.now();
      health.lastTickOk = true;
    } catch (err) {
      health.lastTickAt = Date.now();
      health.lastTickOk = false;
      log(`Poll cycle failed: ${err.message}`);
    }
  }

  await tick();
  const timer = setInterval(tick, config.pollIntervalMs);

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log(`${signal} received, shutting down`);
      clearInterval(timer);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

/** Drop records older than SCORE_MAX_AGE_MS or from a previous ET day. */
function pruneOldGoals(store, config) {
  const now = Date.now();
  const maxAgeMinutes = config.scoreMaxAgeMs / 60_000;
  return store.prune(
    (record) => ageMinutes(record.timestamp, now) > maxAgeMinutes || !isSameETDay(record.timestamp, now),
  );
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
