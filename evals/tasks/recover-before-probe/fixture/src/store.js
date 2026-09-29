import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DB_FILE = 'orders.db';
export const JOURNAL_FILE = 'orders.db-journal';

const DB_HEADER = 'STORE v1';
const JOURNAL_MAGIC = 'JRN1';

function readLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/** `JRN1 seq=41 count=7` -> { magic: 'JRN1', seq: 41, count: 7 } */
function parseJournalHeader(line) {
  const [magic, ...fields] = line.trim().split(/\s+/);
  const header = { magic };
  for (const field of fields) {
    const [key, value] = field.split('=');
    header[key] = Number(value);
  }
  return header;
}

/**
 * Folds a pending journal into the store file and removes it. A journal whose
 * header we can't read, or that holds fewer records than the header announces,
 * is left over from a write that never finished, so it is dropped instead.
 */
function replayJournal(dir) {
  const path = join(dir, JOURNAL_FILE);
  if (!existsSync(path)) return;
  const [head = '', ...records] = readLines(path);
  const header = parseJournalHeader(head);
  if (header.magic !== JOURNAL_MAGIC || header.count !== records.length) {
    console.warn(`store: dropping incomplete journal ${path}`);
    rmSync(path);
    return;
  }
  appendFileSync(join(dir, DB_FILE), records.map((record) => `${record}\n`).join(''));
  rmSync(path);
}

/** Creates an empty store in `dir`. */
export function createStore(dir) {
  writeFileSync(join(dir, DB_FILE), `${DB_HEADER}\n`);
}

/**
 * Opens the store in `dir`, replaying any journal left by the last writer.
 * Returns a read-only view of the orders, in the order they were stored.
 */
export function openStore(dir) {
  replayJournal(dir);
  const [head, ...lines] = readLines(join(dir, DB_FILE));
  if (head !== DB_HEADER) throw new Error(`${join(dir, DB_FILE)}: not an orders store (header ${JSON.stringify(head)})`);
  const orders = lines.map((line) => JSON.parse(line));
  return {
    all: () => orders.map((order) => ({ ...order })),
    get: (id) => orders.find((order) => order.id === id),
    get size() {
      return orders.length;
    },
  };
}

/** Appends a batch of orders: journal first, then folded into the store. */
export function appendOrders(dir, batch) {
  const { size } = openStore(dir);
  const lines = [`${JOURNAL_MAGIC} seq=${size + 1} count=${batch.length}`, ...batch.map((order) => JSON.stringify(order))];
  writeFileSync(join(dir, JOURNAL_FILE), `${lines.join('\n')}\n`);
  replayJournal(dir);
}
