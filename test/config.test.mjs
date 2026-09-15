import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

describe('loadConfig', () => {
  it('throws when BLUESKY_PASSWORD is missing', () => {
    assert.throws(() => loadConfig({}), /BLUESKY_PASSWORD/);
    assert.throws(() => loadConfig({ BLUESKY_PASSWORD: '' }), /BLUESKY_PASSWORD/);
  });

  it('applies defaults', () => {
    const config = loadConfig({ BLUESKY_PASSWORD: 'secret' });
    assert.equal(config.blueskyIdentifier, 'nhl-goal-bot.bsky.social');
    assert.equal(config.pollIntervalMs, 45_000);
    assert.equal(config.maxUpdates, 2);
    assert.equal(config.port, 10_000);
  });

  it('accepts overrides and rejects bad numbers', () => {
    const config = loadConfig({ BLUESKY_PASSWORD: 'x', POLL_INTERVAL_MS: '10000', PORT: '8080' });
    assert.equal(config.pollIntervalMs, 10_000);
    assert.equal(config.port, 8080);
    assert.throws(() => loadConfig({ BLUESKY_PASSWORD: 'x', PORT: 'abc' }), /PORT/);
  });
});
