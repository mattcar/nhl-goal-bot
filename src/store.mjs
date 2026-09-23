/**
 * Persistent record of goals we've seen, so a restart doesn't repost
 * everything. Stored as JSON on disk, written atomically.
 *
 * Record shape: { goal, posted, updateCount, firstSeen, timestamp }
 *
 * The same file also holds small non-goal metadata under reserved keys
 * starting with META_PREFIX (e.g. the game tracker's live set), so there is
 * one durable file to configure and back up. Goal keys are
 * `<gameId>:<eventId>`, so the prefix can never collide. Metadata is
 * excluded from size, entries(), and prune() — goal-record consumers never
 * see it.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ageMinutes, isSameETDay } from './time.mjs';

/** Reserved key prefix for non-goal metadata in the store file. */
const META_PREFIX = '__meta:';

export class GoalStore {
  constructor(path) {
    this.path = path;
    this.records = new Map();
    this.meta = new Map();
    // Serializes save() calls into a queue. The tmp+rename atomic-write
    // pattern is only safe when one save runs at a time: two overlapping
    // saves share one tmp path, so the first rename removes the file the
    // second rename expects, crashing the process with ENOENT. (Seen in
    // production 2026-09-21 when a periodic tick save raced a goal-post save.)
    this._saveQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [key, record] of Object.entries(parsed)) {
        if (key.startsWith(META_PREFIX)) {
          this.meta.set(key.slice(META_PREFIX.length), record);
        } else {
          this.records.set(key, record);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // No store yet — start empty.
    }
    return this;
  }

  /**
   * Persist the store. Safe to call concurrently: saves are queued and run
   * one at a time, so overlapping callers (e.g. the periodic tick and a
   * goal-post handler) can't interleave on the shared tmp file. The returned
   * promise resolves once this call's save has landed. A failed save does
   * not break the queue for later saves.
   */
  async save() {
    const run = this._saveQueue.catch(() => {}).then(() => this._doSave());
    this._saveQueue = run.catch(() => {});
    return run;
  }

  async _doSave() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const data = Object.fromEntries(this.records);
    for (const [key, value] of this.meta) {
      data[`${META_PREFIX}${key}`] = value;
    }
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.path);
  }

  get(key) {
    return this.records.get(key);
  }

  set(key, record) {
    this.records.set(key, record);
  }

  delete(key) {
    return this.records.delete(key);
  }

  has(key) {
    return this.records.has(key);
  }

  get size() {
    return this.records.size;
  }

  /** Read a metadata value (e.g. 'gameTracker'); undefined when absent. */
  getMeta(key) {
    return this.meta.get(key);
  }

  /** Write a metadata value. Call save() afterwards to persist. */
  setMeta(key, value) {
    this.meta.set(key, value);
  }

  /** Iterate [key, record] pairs (e.g. for fuzzy matching). */
  entries() {
    return this.records.entries();
  }

  /**
   * Remove every record matching `predicate`. Returns the number removed.
   * Call save() afterwards to persist.
   */
  prune(predicate) {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (predicate(record, key)) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Drop goal records older than SCORE_MAX_AGE_MS or from a previous ET day —
 * except for games in `protectedGameIds` (currently in progress). A game can
 * span ET midnight (late West Coast starts; the 2026-09-23 dup incident, when
 * the midnight prune wiped a live game's records and all six goals reposted)
 * or run past the max age (multi-OT playoff games), and pruning its records
 * mid-game makes the next poll repost every goal as new.
 *
 * `protectedGameIds` accepts numbers or strings; goal keys are
 * "<gameId>:<eventId>" strings, so ids are normalized before comparing.
 */
export function pruneOldGoals(store, config, protectedGameIds = [], { now = Date.now() } = {}) {
  const maxAgeMinutes = config.scoreMaxAgeMs / 60_000;
  const protectedIds = new Set([...protectedGameIds].map(String));
  return store.prune(
    (record, key) =>
      !protectedIds.has(key.split(':')[0]) &&
      (ageMinutes(record.timestamp, now) > maxAgeMinutes || !isSameETDay(record.timestamp, now)),
  );
}
