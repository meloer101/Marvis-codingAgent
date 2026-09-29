import { createLimiter } from '../ratelimit.js';

// The upstream API accepts bursts of up to 50 records, 10 records/s sustained.
const limiter = createLimiter({ capacity: 50, refillPerSec: 10 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function syncBatches(batches, upload, log = console.log) {
  for (const batch of batches) {
    let res = limiter.take('sync', batch.length);
    while (!res.ok) {
      if (res.retryAfterMs === Infinity) {
        throw new Error(`a batch of ${batch.length} records is larger than the upload budget`);
      }
      await sleep(res.retryAfterMs);
      res = limiter.take('sync', batch.length);
    }
    await upload(batch);
    log(`synced ${batch.length} records (${Math.floor(res.remaining)} left in budget)`);
  }
}
