import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalStore, pruneOldGoals } from '../src/store.mjs';

describe('GoalStore', () => {
  let dir;
  let path;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'goalstore-'));
    path = join(dir, 'nested', 'goals.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty when no file exists', async () => {
    const store = await new GoalStore(path).load();
    assert.equal(store.size, 0);
  });

  it('round-trips records through save/load', async () => {
    const store = await new GoalStore(path).load();
    store.set('1:100', { goal: { scorer: 'A' }, posted: true, updateCount: 0 });
    await store.save();

    const reloaded = await new GoalStore(path).load();
    assert.equal(reloaded.size, 1);
    assert.deepEqual(reloaded.get('1:100').goal, { scorer: 'A' });
  });

  it('prune removes matching records and reports the count', async () => {
    const store = await new GoalStore(path).load();
    store.set('1:1', { posted: true });
    store.set('1:2', { posted: false });
    const removed = store.prune((record) => record.posted);
    assert.equal(removed, 1);
    assert.ok(!store.has('1:1'));
    assert.ok(store.has('1:2'));
  });

  it('throws on corrupt JSON instead of silently starting empty', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not json{{{');
    await assert.rejects(() => new GoalStore(path).load(), SyntaxError);
  });
});

describe('GoalStore metadata', () => {
  let dir;
  let path;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'goalstore-meta-'));
    path = join(dir, 'nested', 'goals.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips metadata alongside records', async () => {
    const store = await new GoalStore(path).load();
    store.set('1:100', { goal: { scorer: 'A' }, posted: true });
    store.setMeta('gameTracker', { recentlyLive: [5], updatedAt: 123 });
    await store.save();

    const reloaded = await new GoalStore(path).load();
    assert.deepEqual(reloaded.get('1:100').goal, { scorer: 'A' });
    assert.deepEqual(reloaded.getMeta('gameTracker'), { recentlyLive: [5], updatedAt: 123 });
  });

  it('excludes metadata from size, entries, and prune', async () => {
    const store = await new GoalStore(path).load();
    store.set('1:1', { posted: true, timestamp: 1 });
    store.setMeta('gameTracker', { recentlyLive: [] });
    assert.equal(store.size, 1);
    assert.deepEqual(
      [...store.entries()].map(([key]) => key),
      ['1:1'],
    );
    assert.equal(store.prune(() => true), 1);
    assert.deepEqual(store.getMeta('gameTracker'), { recentlyLive: [] });
  });

  it('loads pre-metadata store files as pure records', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ '1:1': { posted: true } }));
    const store = await new GoalStore(path).load();
    assert.equal(store.size, 1);
    assert.equal(store.getMeta('gameTracker'), undefined);
  });
});

describe('GoalStore concurrent saves', () => {
  let dir;
  let path;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'goalstore-race-'));
    path = join(dir, 'goals.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serializes concurrent saves instead of crashing with ENOENT', async () => {
    // Regression: 2026-09-21 production crash — a periodic tick save raced a
    // goal-post save on the shared tmp file and the losing rename threw
    // ENOENT, killing the process.
    const store = await new GoalStore(path).load();
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        store.set(`game:${i}`, { goal: { scorer: 'Racer' }, posted: true });
        return store.save();
      }),
    );

    const reloaded = await new GoalStore(path).load();
    assert.equal(reloaded.size, 60);
  });

  it('a failed save does not break the queue for later saves', async () => {
    // A regular file blocks the directory the save needs to create, so this
    // save must fail — but the next save on a healthy store still works.
    const { writeFile } = await import('node:fs/promises');
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const bad = new GoalStore(join(blocker, 'goals.json'));
    await assert.rejects(() => bad.save());

    const store = await new GoalStore(path).load();
    store.set('1:1', { posted: true });
    await store.save();
    const reloaded = await new GoalStore(path).load();
    assert.equal(reloaded.size, 1);
  });
});

describe('pruneOldGoals', () => {
  // Fixed "now": 2026-09-23T04:30:00Z = 00:30 ET on Sep 23, just after the ET
  // midnight flip that caused the 2026-09-23 duplicate incident.
  const NOW = new Date('2026-09-23T04:30:00Z').getTime();
  const config = { scoreMaxAgeMs: 4 * 60 * 60 * 1000 };
  const GAME = 2026010030; // numeric, like NhlClient.liveGameIds returns

  let dir;
  let path;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prune-'));
    path = join(dir, 'goals.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function storeWith(records) {
    const store = await new GoalStore(path).load();
    for (const [key, timestamp] of records) {
      store.set(key, { goal: { scorer: 'S' }, posted: true, timestamp });
    }
    return store;
  }

  it('prunes records older than SCORE_MAX_AGE_MS', async () => {
    const store = await storeWith([[`${GAME}:1`, NOW - 5 * 60 * 60 * 1000]]);
    assert.equal(pruneOldGoals(store, config, [], { now: NOW }), 1);
    assert.equal(store.size, 0);
  });

  it('prunes fresh records from a previous ET day', async () => {
    // 22:30 ET Sep 22 — only 2h old, but a different ET day than NOW.
    const store = await storeWith([[`${GAME}:1`, new Date('2026-09-23T02:30:00Z').getTime()]]);
    assert.equal(pruneOldGoals(store, config, [], { now: NOW }), 1);
    assert.equal(store.size, 0);
  });

  it("keeps a live game's records across ET midnight (2026-09-23 dup regression)", async () => {
    const store = await storeWith([[`${GAME}:1`, new Date('2026-09-23T02:30:00Z').getTime()]]);
    assert.equal(pruneOldGoals(store, config, [GAME], { now: NOW }), 0);
    assert.equal(store.size, 1);
  });

  it("keeps a live game's records past max age (multi-OT playoff games)", async () => {
    const store = await storeWith([[`${GAME}:1`, NOW - 5.5 * 60 * 60 * 1000]]);
    assert.equal(pruneOldGoals(store, config, [GAME], { now: NOW }), 0);
    assert.equal(store.size, 1);
  });

  it('keeps fresh records from the current ET day', async () => {
    const store = await storeWith([[`${GAME}:1`, NOW - 30 * 60 * 1000]]);
    assert.equal(pruneOldGoals(store, config, [], { now: NOW }), 0);
    assert.equal(store.size, 1);
  });

  it('matches protected game ids regardless of number/string type', async () => {
    const store = await storeWith([[`${GAME}:1`, NOW - 5 * 60 * 60 * 1000]]);
    assert.equal(pruneOldGoals(store, config, [String(GAME)], { now: NOW }), 0);
    assert.equal(store.size, 1);
  });
});
