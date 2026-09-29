/**
 * Token-bucket rate limiting, one bucket per key.
 *
 *   const limiter = createLimiter({ capacity: 20, refillPerSec: 5 });
 *   const { ok, remaining, retryAfterMs } = limiter.take(key, cost);
 *
 * Each key starts with `capacity` tokens and refills continuously at
 * `refillPerSec` tokens per second, never above `capacity`. A take that can't
 * be paid in full takes nothing; `retryAfterMs` says how long until it could
 * be (Infinity when `cost` exceeds `capacity`). `remaining` is the number of
 * tokens left after the call. `now` returns the current time in milliseconds.
 */
export function createLimiter({ capacity, refillPerSec, now = Date.now }) {
  const buckets = new Map();

  function take(key, cost = 1) {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, at: t };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + ((t - bucket.at) * refillPerSec) / 1000);
    bucket.at = t;

    if (cost <= bucket.tokens) {
      bucket.tokens -= cost;
      return { ok: true, remaining: bucket.tokens, retryAfterMs: 0 };
    }
    const retryAfterMs = cost > capacity ? Infinity : Math.ceil(((cost - bucket.tokens) * 1000) / refillPerSec);
    return { ok: false, remaining: bucket.tokens, retryAfterMs };
  }

  return { take };
}
