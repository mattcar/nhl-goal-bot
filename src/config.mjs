/**
 * Configuration, loaded from environment variables with validation.
 * Throws on missing/invalid values so misconfiguration fails fast at startup.
 */

export function loadConfig(env = process.env) {
  const num = (name, def) => {
    const raw = env[name];
    if (raw == null || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${name} must be a non-negative number (got "${raw}")`);
    }
    return n;
  };

  const blueskyPassword = env.BLUESKY_PASSWORD;
  if (!blueskyPassword) {
    throw new Error('BLUESKY_PASSWORD environment variable is required');
  }

  return {
    blueskyIdentifier: env.BLUESKY_IDENTIFIER || 'nhl-goal-bot.bsky.social',
    blueskyPassword,
    pollIntervalMs: num('POLL_INTERVAL_MS', 45_000),
    initialDelayMs: num('INITIAL_DELAY_MS', 45_000),
    postDelayMs: num('POST_DELAY_MS', 60_000),
    maxUpdates: num('MAX_UPDATES', 2),
    apiBaseUrl: env.NHL_API_BASE_URL || 'https://api-web.nhle.com/v1',
    scoreMaxAgeMs: num('SCORE_MAX_AGE_MS', 4 * 60 * 60 * 1000),
    storePath: env.GOAL_STORE_PATH || './data/posted-goals.json',
    port: num('PORT', 10_000),
  };
}
