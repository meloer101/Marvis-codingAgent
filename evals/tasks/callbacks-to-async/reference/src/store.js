import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Settle `promise` into a Node-style callback when one is given; otherwise
 * hand the promise back. In callback mode nothing is returned, so a failure
 * reaches the caller once, through the callback, and never as a rejected
 * promise nobody is listening to.
 */
function withCallback(promise, cb) {
  if (typeof cb !== 'function') return promise;
  promise.then((value) => cb(null, value), cb);
}

/**
 * A small file-backed key/value store. Every key lives in its own JSON file
 * under `dir`, so values must be JSON-serialisable.
 *
 * Every method returns a promise. For older callers, each one also accepts a
 * Node-style callback as its last argument; it then returns nothing. A key
 * that does not exist is reported as an Error with `code === 'ENOKEY'` and a
 * `key` property naming the key (the promise rejects with it, or the callback
 * receives it).
 *
 * @param {string} dir directory holding the data files (created on first write)
 */
export function createStore(dir) {
  const fileFor = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);

  function noSuchKey(key) {
    const err = new Error(`no such key: ${key}`);
    err.code = 'ENOKEY';
    err.key = key;
    return err;
  }

  /**
   * Read a value.
   * @param {string} key
   * @param {(err: Error | null, value?: unknown) => void} [cb]
   * @returns {Promise<unknown> | void}
   */
  function get(key, cb) {
    const read = async () => {
      let text;
      try {
        text = await readFile(fileFor(key), 'utf8');
      } catch (err) {
        throw err.code === 'ENOENT' ? noSuchKey(key) : err;
      }
      return JSON.parse(text);
    };
    return withCallback(read(), cb);
  }

  /**
   * Write a value, replacing any previous one.
   * @param {string} key
   * @param {unknown} value
   * @param {(err: Error | null) => void} [cb]
   * @returns {Promise<void> | void}
   */
  function set(key, value, cb) {
    const write = async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(fileFor(key), JSON.stringify(value));
    };
    return withCallback(write(), cb);
  }

  /**
   * Delete a key. Deleting a key that does not exist is an ENOKEY error.
   * @param {string} key
   * @param {(err: Error | null) => void} [cb]
   * @returns {Promise<void> | void}
   */
  function del(key, cb) {
    const remove = async () => {
      try {
        await unlink(fileFor(key));
      } catch (err) {
        throw err.code === 'ENOENT' ? noSuchKey(key) : err;
      }
    };
    return withCallback(remove(), cb);
  }

  /**
   * List the keys that start with `prefix`, sorted. A store that has never
   * been written to has no keys.
   * @param {string} [prefix] only keys starting with this; every key if omitted
   * @param {(err: Error | null, keys?: string[]) => void} [cb]
   * @returns {Promise<string[]> | void}
   */
  function list(prefix, cb) {
    if (typeof prefix === 'function') {
      cb = prefix;
      prefix = '';
    }
    const scan = async () => {
      let names;
      try {
        names = await readdir(dir);
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
        .filter((key) => key.startsWith(prefix ?? ''))
        .sort();
    };
    return withCallback(scan(), cb);
  }

  return { get, set, del, list };
}
