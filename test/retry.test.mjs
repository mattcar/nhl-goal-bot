import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retryForever } from '../src/retry.mjs';

describe('retryForever', () => {
  it('returns the first successful result', async () => {
    let calls = 0;
    const result = await retryForever(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('boom');
        return 'ok';
      },
      { initialDelayMs: 1, maxDelayMs: 2 },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('backs off exponentially up to the cap', async () => {
    const waits = [];
    let calls = 0;
    await retryForever(
      async () => {
        calls += 1;
        if (calls <= 4) throw new Error('boom');
        return 'ok';
      },
      {
        initialDelayMs: 10,
        maxDelayMs: 25,
        onError: (_err, waitMs) => waits.push(waitMs),
      },
    );
    assert.deepEqual(waits, [10, 20, 25, 25]);
  });

  it('reports the attempt number to onError', async () => {
    const attempts = [];
    let calls = 0;
    await retryForever(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('boom');
        return 'ok';
      },
      { initialDelayMs: 1, onError: (_err, _waitMs, attempt) => attempts.push(attempt) },
    );
    assert.deepEqual(attempts, [1, 2]);
  });
});
