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

/** Reserved key prefix for non-goal metadata in the store file. */
const META_PREFIX = '__meta:';

export class GoalStore {
  constructor(path) {
    this.path = path;
    this.records = new Map();
    this.meta = new Map();
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

  async save() {
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
