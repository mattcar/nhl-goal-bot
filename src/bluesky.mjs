/**
 * Bluesky posting with a single retry path. There is exactly one place that
 * posts, and exactly one recovery strategy: if the post fails for a reason
 * that looks like a dead session (or returns no URI), log in again and retry
 * once. Anything else throws to the caller.
 */

import { Bot } from '@skyware/bot';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SESSION_FAILURE = /up|stream|failed to fetch|auth|session|token|expired|unauthorized|502/i;

export class BlueskyPoster {
  constructor({ identifier, password, maxLoginRetries = 5 }) {
    this.identifier = identifier;
    this.password = password;
    this.maxLoginRetries = maxLoginRetries;
    this.bot = new Bot();
  }

  async login() {
    let lastError;
    for (let attempt = 1; attempt <= this.maxLoginRetries; attempt += 1) {
      try {
        await this.bot.login({ identifier: this.identifier, password: this.password });
        return;
      } catch (err) {
        lastError = err;
        if (attempt === this.maxLoginRetries) break;
        const transient = SESSION_FAILURE.test(err?.message ?? '') || err?.status === 502;
        await delay(transient ? 60_000 : 30_000);
      }
    }
    throw lastError;
  }

  async post(text) {
    try {
      return await this.attemptPost(text);
    } catch (err) {
      if (!this.isSessionFailure(err)) throw err;
      await this.login();
      return this.attemptPost(text);
    }
  }

  async attemptPost(text) {
    const response = await this.bot.post({ text });
    if (!response?.uri) {
      throw new Error('Bluesky post returned no URI');
    }
    return response;
  }

  isSessionFailure(err) {
    if (!err) return true; // no-URI case is treated as a dead session
    return SESSION_FAILURE.test(err.message ?? '') || err.status === 502 || err.status === 401;
  }
}
