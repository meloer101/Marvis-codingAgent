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

async function main(command, args) {
  switch (command) {
    case 'get':
      console.log(JSON.stringify(await store.get(args[0])));
      break;

    case 'set': {
      let value;
      try {
        value = JSON.parse(args[1]);
      } catch {
        throw new Error(`not valid JSON: ${args[1]}`);
      }
      await store.set(args[0], value);
      break;
    }

    case 'rm':
      await store.del(args[0]);
      break;

    case 'incr': {
      const by = args[1] === undefined ? 1 : Number(args[1]);
      let current = 0;
      try {
        current = await store.get(args[0]);
      } catch (err) {
        if (err.code !== 'ENOKEY') throw err;
      }
      const next = current + by;
      await store.set(args[0], next);
      console.log(next);
      break;
    }

    case 'rename': {
      const value = await store.get(args[0]);
      await store.set(args[1], value);
      await store.del(args[0]);
      console.log(`${args[0]} -> ${args[1]}`);
      break;
    }

    case 'ls':
      for (const key of await store.list(args[0] || '')) console.log(key);
      break;

    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  await main(command, args);
} catch (err) {
  fail(err);
}
