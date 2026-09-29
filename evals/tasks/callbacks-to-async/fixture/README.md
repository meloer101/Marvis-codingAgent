# kv

A tiny file-backed key/value store, and the `kv` command-line tool built on it.
Each key is stored as a JSON file in the data directory (`$KV_DIR`, default `./data`).

## CLI

```
node src/app.js set greeting '"hello"'
node src/app.js get greeting
node src/app.js incr visits
node src/app.js rename greeting welcome
node src/app.js ls user:
node src/app.js rm welcome
```

A missing key prints `not found: <key>` and exits with status 1.

## Library

```js
import { createStore } from './src/store.js';

const store = createStore('data');
store.get('greeting', (err, value) => { /* ... */ });
```

See the JSDoc in `src/store.js` for the full API.

## Plugins

`plugins/` holds the audit and backup plugins from the platform team. They are
synced from their repo, so don't edit them here.

## Tests

```
npm test
```
