/**
 * Rate limiting for the gateway.
 *
 * Fixed window per client: each key gets `max` hits per `windowMs`, and
 * `limit(key)` returns true while the key is still under its quota.
 *
 *   const limiter = createLimiter({ max: 100, windowMs: 60_000 });
 *   if (!limiter.limit(req.ip)) return tooManyRequests();
 */
export function createLimiter(options) {
  throw new Error('not implemented');
}
