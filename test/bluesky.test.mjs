import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BlueskyPoster } from '../src/bluesky.mjs';

describe('BlueskyPoster', () => {
  it('disables the @skyware/bot background event poller', () => {
    const poster = new BlueskyPoster({ identifier: 'test', password: 'test' });
    // With emitEvents:false the library never creates its BotEventEmitter,
    // so a failed notification poll can't surface as an unhandled 'error'
    // event and crash the process.
    assert.equal(poster.bot.eventEmitter, undefined);
    assert.equal(poster.bot.chatEventEmitter, undefined);
  });
});
