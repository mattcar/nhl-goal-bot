import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalStore } from '../src/store.mjs';

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
