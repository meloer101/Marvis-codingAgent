/**
 * Run `fn` over `items` with at most `limit` calls pending at any time.
 *
 * `fn(item, index)` may return a value or a promise; if it throws, that counts
 * as a rejection. Results are in the same order as `items`.
 *
 * By default the returned promise rejects with the first error, and no further
 * items are started (calls that are already running are left to finish; their
 * results are ignored).
 *
 * With `{ settle: true }` it never rejects: every item is run, and the promise
 * resolves to one entry per item, in input order, shaped like the entries of
 * `Promise.allSettled` — `{ status: 'fulfilled', value }` or
 * `{ status: 'rejected', reason }`.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit maximum number of pending calls (>= 1)
 * @param {(item: T, index: number) => R | Promise<R>} fn
 * @param {{ settle?: boolean }} [options]
 * @returns {Promise<R[] | PromiseSettledResult<R>[]>}
 */
export function mapLimit(items, limit, fn, { settle = false } = {}) {
  return new Promise((resolve, reject) => {
    const results = [];
    let next = 0;
    let active = 0;
    let failed = false;

    if (items.length === 0) {
      resolve(results);
      return;
    }

    const launch = () => {
      while (active < limit && next < items.length && !failed) {
        const index = next++;
        active++;
        Promise.resolve()
          .then(() => fn(items[index], index))
          .then(
            (value) => {
              results.push(settle ? { status: 'fulfilled', value } : value);
            },
            (reason) => {
              if (!settle) {
                failed = true;
                reject(reason);
                return;
              }
              results.push({ status: 'rejected', reason });
              active--;
            },
          )
          .finally(() => {
            active--;
            if (failed) return;
            if (results.length === items.length) resolve(results);
            else launch();
          });
      }
    };

    launch();
  });
}
