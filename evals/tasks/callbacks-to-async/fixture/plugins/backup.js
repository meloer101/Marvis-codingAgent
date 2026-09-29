// Synced from the platform team's kv-plugins repo. Don't edit here; changes go upstream.

/**
 * Copy every key starting with `prefix` from one store to another. A key that
 * is deleted while the copy is running is skipped, not an error.
 *
 * @param {{ list: Function, get: Function }} from
 * @param {{ set: Function }} to
 * @param {string} prefix
 * @param {(err: Error | null, copied?: string[]) => void} cb
 */
export function copyPrefix(from, to, prefix, cb) {
  from.list(prefix, (err, keys) => {
    if (err) return cb(err);
    const copied = [];
    let i = 0;
    const next = () => {
      if (i === keys.length) return cb(null, copied);
      const key = keys[i++];
      from.get(key, (err, value) => {
        if (err && err.code === 'ENOKEY') return next();
        if (err) return cb(err);
        to.set(key, value, (err) => {
          if (err) return cb(err);
          copied.push(key);
          next();
        });
      });
    };
    next();
  });
}

/**
 * Delete the given keys. Keys that are already gone are ignored.
 *
 * @param {{ del: Function }} store
 * @param {string[]} keys
 * @param {(err: Error | null, removed?: string[]) => void} cb  the keys that were actually deleted
 */
export function prune(store, keys, cb) {
  const removed = [];
  let i = 0;
  const next = () => {
    if (i === keys.length) return cb(null, removed);
    const key = keys[i++];
    store.del(key, (err) => {
      if (err && err.code !== 'ENOKEY') return cb(err);
      if (!err) removed.push(key);
      next();
    });
  };
  next();
}
