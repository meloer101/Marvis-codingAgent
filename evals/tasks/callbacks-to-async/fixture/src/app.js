#!/usr/bin/env node
import { createStore } from './store.js';

const USAGE = `usage: node src/app.js <command>

  get <key>             print a value as JSON
  set <key> <json>      store a value
  rm <key>              delete a key
  incr <key> [by]       add to a number (a missing key counts as 0)
  rename <from> <to>    move a value to a new key
  ls [prefix]           list keys`;

const store = createStore(process.env.KV_DIR || 'data');

function fail(err) {
  console.error(err.code === 'ENOKEY' ? `not found: ${err.key}` : `error: ${err.message}`);
  process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'get':
    store.get(args[0], (err, value) => {
      if (err) return fail(err);
      console.log(JSON.stringify(value));
    });
    break;

  case 'set': {
    let value;
    try {
      value = JSON.parse(args[1]);
    } catch {
      fail(new Error(`not valid JSON: ${args[1]}`));
      break;
    }
    store.set(args[0], value, (err) => {
      if (err) return fail(err);
    });
    break;
  }

  case 'rm':
    store.del(args[0], (err) => {
      if (err) return fail(err);
    });
    break;

  case 'incr': {
    const by = args[1] === undefined ? 1 : Number(args[1]);
    store.get(args[0], (err, current) => {
      if (err && err.code !== 'ENOKEY') return fail(err);
      const next = (err ? 0 : current) + by;
      store.set(args[0], next, (err) => {
        if (err) return fail(err);
        console.log(next);
      });
    });
    break;
  }

  case 'rename':
    store.get(args[0], (err, value) => {
      if (err) return fail(err);
      store.set(args[1], value, (err) => {
        if (err) return fail(err);
        store.del(args[0], (err) => {
          if (err) return fail(err);
          console.log(`${args[0]} -> ${args[1]}`);
        });
      });
    });
    break;

  case 'ls':
    store.list(args[0] || '', (err, keys) => {
      if (err) return fail(err);
      for (const key of keys) console.log(key);
    });
    break;

  default:
    console.error(USAGE);
    process.exitCode = command ? 1 : 0;
}
