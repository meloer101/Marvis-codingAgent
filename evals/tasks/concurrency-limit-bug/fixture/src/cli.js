#!/usr/bin/env node
// Usage: node src/cli.js urls.txt   (one url per line)
import { readFile } from 'node:fs/promises';

import { crawl } from './crawl.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/cli.js <urls.txt>');
  process.exit(1);
}

const urls = (await readFile(file, 'utf8'))
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

for (const row of await crawl(urls)) {
  console.log(row.ok ? `${row.status}  ${row.bytes}B  ${row.url}` : `ERR  ${row.error}  ${row.url}`);
}
