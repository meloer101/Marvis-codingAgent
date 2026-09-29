import fs from 'node:fs';
import path from 'node:path';

/**
 * A small file-backed key/value store. Every key lives in its own JSON file
 * under `dir`, so values must be JSON-serialisable.
 *
 * Every method takes a Node-style callback as its last argument. A key that
 * does not exist is reported as an Error with `code === 'ENOKEY'` and a `key`
 * property naming the key.
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
   * @param {(err: Error | null, value?: unknown) => void} cb
   */
  function get(key, cb) {
    fs.readFile(fileFor(key), 'utf8', (err, text) => {
      if (err) return cb(err.code === 'ENOENT' ? noSuchKey(key) : err);
      let value;
      try {
        value = JSON.parse(text);
      } catch (parseErr) {
        return cb(parseErr);
      }
      cb(null, value);
    });
  }

  /**
   * Write a value, replacing any previous one.
   * @param {string} key
   * @param {unknown} value
   * @param {(err: Error | null) => void} cb
   */
  function set(key, value, cb) {
    fs.mkdir(dir, { recursive: true }, (err) => {
      if (err) return cb(err);
      fs.writeFile(fileFor(key), JSON.stringify(value), (err) => cb(err || null));
    });
  }

  /**
   * Delete a key. Deleting a key that does not exist is an ENOKEY error.
   * @param {string} key
   * @param {(err: Error | null) => void} cb
   */
  function del(key, cb) {
    fs.unlink(fileFor(key), (err) => {
      if (err) return cb(err.code === 'ENOENT' ? noSuchKey(key) : err);
      cb(null);
    });
  }

  /**
   * List the keys that start with `prefix`, sorted. A store that has never
   * been written to has no keys.
   * @param {string} [prefix] only keys starting with this; every key if omitted
   * @param {(err: Error | null, keys?: string[]) => void} cb
   */
  function list(prefix, cb) {
    if (typeof prefix === 'function') {
      cb = prefix;
      prefix = '';
    }
    fs.readdir(dir, (err, names) => {
      if (err) return err.code === 'ENOENT' ? cb(null, []) : cb(err);
      const keys = names
        .filter((name) => name.endsWith('.json'))
        .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
        .filter((key) => key.startsWith(prefix))
        .sort();
      cb(null, keys);
    });
  }

  return { get, set, del, list };
}
