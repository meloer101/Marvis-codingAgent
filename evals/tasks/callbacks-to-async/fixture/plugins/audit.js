// Synced from the platform team's kv-plugins repo. Don't edit here; changes go upstream.

/**
 * Report which of the `required` keys are missing from `store`.
 *
 * @param {{ get: Function }} store
 * @param {string[]} required
 * @param {(err: Error | null, missing?: string[]) => void} cb  missing keys, sorted
 */
export function findMissing(store, required, cb) {
  const missing = [];
  let pending = required.length;
  let finished = false;
  if (pending === 0) return process.nextTick(cb, null, missing);

  for (const key of required) {
    store.get(key, (err) => {
      if (finished) return;
      if (err && err.code !== 'ENOKEY') {
        finished = true;
        return cb(err);
      }
      if (err) missing.push(key);
      if (--pending === 0) {
        finished = true;
        cb(null, missing.sort());
      }
    });
  }
}

/**
 * Count the keys in each namespace (the part of a key before the first ':';
 * keys without one are counted under '').
 *
 * @param {{ list: Function }} store
 * @param {(err: Error | null, counts?: Record<string, number>) => void} cb
 */
export function namespaces(store, cb) {
  store.list((err, keys) => {
    if (err) return cb(err);
    const counts = {};
    for (const key of keys) {
      const ns = key.includes(':') ? key.slice(0, key.indexOf(':')) : '';
      counts[ns] = (counts[ns] || 0) + 1;
    }
    cb(null, counts);
  });
}
