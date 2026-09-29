#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { USAGE, UsageError, parseArgs } from '../src/args.js';
import { buildFilter } from '../src/filter.js';
import { formatTable } from '../src/format.js';

function parseEvents(text, file) {
  const events = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      events.push(JSON.parse(line));
    } catch {
      process.stderr.write(`logq: ${file}:${i + 1}: skipping a line that is not valid JSON\n`);
    }
  });
  return events;
}

function main(argv) {
  let opts;
  try {
    const now = process.env.LOGQ_NOW ? new Date(process.env.LOGQ_NOW) : new Date();
    opts = parseArgs(argv, { now });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`logq: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let text;
  try {
    text = readFileSync(opts.file === '-' ? 0 : opts.file, 'utf8');
  } catch (err) {
    process.stderr.write(`logq: cannot read ${opts.file}: ${err.code ?? err.message}\n`);
    return 1;
  }

  const events = parseEvents(text, opts.file).filter(buildFilter(opts));
  process.stdout.write(opts.json ? events.map((e) => `${JSON.stringify(e)}\n`).join('') : formatTable(events));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
