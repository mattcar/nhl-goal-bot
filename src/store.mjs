/**
 * Persistent record of goals we've seen, so a restart doesn't repost
 * everything. Stored as JSON on disk, written atomically.
 *
 * Record shape: { goal, posted, updateCount, firstSeen, timestamp }
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export class GoalStore {
  constructor(path) {
    this.path = path;
    this.records = new Map();
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [key, record] of Object.entries(parsed)) {
        this.records.set(key, record);
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
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2));
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
