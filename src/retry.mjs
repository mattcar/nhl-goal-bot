/**
 * Retry helpers for operations that must survive transient outages.
 * Pure logic (no I/O except the injected fn) so it's easy to unit test.
 */

/**
 * Call `fn` until it resolves. On rejection, wait with exponential backoff
 * (initialDelayMs doubling each time, capped at maxDelayMs) and try again.
 * `onError(err, waitMs, attempt)` runs before each wait.
 *
 * Never gives up — for things like the initial Bluesky login, where dying
 * would just drop the process into a Render crash loop.
 */
export async function retryForever(
  fn,
  { initialDelayMs = 5000, maxDelayMs = 5 * 60_000, onError } = {},
) {
  let waitMs = initialDelayMs;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (onError) onError(err, waitMs, attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      waitMs = Math.min(waitMs * 2, maxDelayMs);
    }
  }
}
