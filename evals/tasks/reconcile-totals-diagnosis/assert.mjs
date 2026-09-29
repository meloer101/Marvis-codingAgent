import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Derived from agents that find one plausible cause, give a confident diagnosis
// and stop. The totals are off for two independent reasons: re-sent
// transactions whose id differs only in case / surrounding spaces slip past the
// exact-id dedupe, and refunds written as "(12.50)" parse to NaN and are
// skipped. Fixing either one alone still leaves accounts off.
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// data/transactions.csv exactly as shipped, and finance's totals for it (cents).
const ORIGINAL_CSV = `id,account,amount,date
TX-0001,ACC-103,411.00,2026-09-01
TX-0002,ACC-104,482.96,2026-09-01
TX-0003,ACC-101,327.97,2026-09-01
TX-0004,ACC-106,57.96,2026-09-01
TX-0005,ACC-102,300.91,2026-09-02
TX-0006,ACC-103,466.39,2026-09-02
TX-0007,ACC-105,86.00,2026-09-02
TX-0008,ACC-102,291.86,2026-09-02
TX-0009,ACC-103,543.00,2026-09-03
TX-0010,ACC-105,284.13,2026-09-03
TX-0011,ACC-103,180.24,2026-09-03
TX-0012,ACC-101,540.50,2026-09-03
TX-0013,ACC-102,110.25,2026-09-04
TX-0014,ACC-102,-9.82,2026-09-04
TX-0015,ACC-103,284.00,2026-09-04
TX-0016,ACC-103,95.40,2026-09-04
TX-0017,ACC-104,5.60,2026-09-05
TX-0018,ACC-102,411.00,2026-09-05
TX-0019,ACC-104,502.00,2026-09-05
TX-0017,ACC-104,5.60,2026-09-05
TX-0020,ACC-103,573.50,2026-09-05
TX-0021,ACC-104,213.00,2026-09-06
TX-0022,ACC-105,574.00,2026-09-06
TX-0023,ACC-104,288.00,2026-09-06
TX-0024,ACC-105,55.02,2026-09-06
TX-0025,ACC-101,168.00,2026-09-07
TX-0026,ACC-105,397.00,2026-09-07
TX-0027,ACC-104,38.00,2026-09-07
TX-0028,ACC-101,322.92,2026-09-07
TX-0029,ACC-102,(12.50),2026-09-08
TX-0030,ACC-106,494.26,2026-09-08
TX-0031,ACC-104,291.89,2026-09-08
TX-0032,ACC-106,383.00,2026-09-08
TX-0033,ACC-103,78.00,2026-09-09
TX-0034,ACC-106,65.43,2026-09-09
TX-0035,ACC-102,306.50,2026-09-09
TX-0036,ACC-102,142.16,2026-09-09
TX-0037,ACC-104,256.00,2026-09-10
TX-0038,ACC-105,244.73,2026-09-10
TX-0039,ACC-101,211.83,2026-09-10
TX-0040,ACC-102,454.00,2026-09-10
TX-0041,ACC-106,257.83,2026-09-11
TX-0042,ACC-101,36.00,2026-09-11
TX-0043,ACC-101,106.00,2026-09-11
TX-0044,ACC-101,454.00,2026-09-11
TX-0045,ACC-106,436.02,2026-09-12
TX-0046,ACC-104,578.10,2026-09-12
TX-0047,ACC-106,297.02,2026-09-12
 tx-0042,ACC-101,36.00,2026-09-11
TX-0048,ACC-103,93.67,2026-09-12
TX-0049,ACC-103,422.00,2026-09-13
TX-0050,ACC-101,376.29,2026-09-13
TX-0051,ACC-105,-14.63,2026-09-13
TX-0052,ACC-104,544.31,2026-09-13
TX-0053,ACC-102,547.34,2026-09-14
TX-0054,ACC-106,349.09,2026-09-14
TX-0055,ACC-106,240.03,2026-09-14
TX-0056,ACC-106,240.03,2026-09-14
TX-0057,ACC-104,81.51,2026-09-15
TX-0058,ACC-101,267.82,2026-09-15
TX-0059,ACC-105,251.39,2026-09-15
TX-0060,ACC-102,11.00,2026-09-15
TX-0061,ACC-101,604.93,2026-09-16
TX-0062,ACC-102,593.91,2026-09-16
TX-0063,ACC-103,18.80,2026-09-16
TX-0064,ACC-101,481.00,2026-09-16
TX-0065,ACC-105,354.32,2026-09-17
TX-0066,ACC-105,454.14,2026-09-17
TX-0067,ACC-101,186.35,2026-09-17
TX-0068,ACC-102,172.52,2026-09-17
TX-0069,ACC-101,539.00,2026-09-18
Tx-0063,ACC-103,18.80,2026-09-16
TX-0070,ACC-106,473.77,2026-09-18
TX-0071,ACC-103,(86.00),2026-09-18
TX-0072,ACC-106,192.52,2026-09-18
TX-0073,ACC-102,550.66,2026-09-19
TX-0074,ACC-106,158.00,2026-09-19
TX-0075,ACC-102,329.00,2026-09-19
TX-0076,ACC-106,114.00,2026-09-19
TX-0077,ACC-102,198.93,2026-09-20
TX-0078,ACC-104,194.26,2026-09-20
TX-0079,ACC-106,597.00,2026-09-20
TX-0080,ACC-103,412.00,2026-09-20
TX-0081,ACC-103,492.99,2026-09-21
TX-0082,ACC-101,522.39,2026-09-21
TX-0080,ACC-103,412.00,2026-09-20
TX-0083,ACC-104,367.00,2026-09-21
TX-0084,ACC-105,375.71,2026-09-21
TX-0085,ACC-105,153.87,2026-09-22
TX-0086,ACC-105,224.28,2026-09-22
TX-0087,ACC-101,140.80,2026-09-22
TX-0088,ACC-104,125.00,2026-09-22
TX-0089,ACC-106,464.67,2026-09-23
TX-0090,ACC-103,65.97,2026-09-23
TX-0091,ACC-103,509.61,2026-09-23
TX-0088 ,ACC-104,125.00,2026-09-22
TX-0092,ACC-101,287.95,2026-09-23
TX-0093,ACC-106,321.64,2026-09-24
TX-0094,ACC-101,321.41,2026-09-24
TX-0095,ACC-106,482.09,2026-09-24
TX-0096,ACC-102,93.00,2026-09-24
TX-0097,ACC-103,-20.61,2026-09-25
TX-0098,ACC-101,496.84,2026-09-25
TX-0099,ACC-103,509.24,2026-09-25
TX-0100,ACC-105,313.81,2026-09-25
TX-0101,ACC-101,42.50,2026-09-26
TX-0102,ACC-106,215.39,2026-09-26
TX-0103,ACC-106,385.45,2026-09-26
TX-0104,ACC-102,(4.99),2026-09-26
TX-0105,ACC-102,15.76,2026-09-27
tx-0101,ACC-101,42.50,2026-09-26
TX-0106,ACC-105,541.00,2026-09-27
TX-0107,ACC-102,448.34,2026-09-27
TX-0108,ACC-105,133.76,2026-09-27
TX-0109,ACC-101,24.49,2026-09-28
TX-0110,ACC-102,62.32,2026-09-28
TX-0111,ACC-101,359.00,2026-09-28
TX-0112,ACC-103,86.63,2026-09-28
`;
const FINANCE = {"ACC-101":681799,"ACC-102":501215,"ACC-103":513583,"ACC-104":396763,"ACC-105":442853,"ACC-106":622520};
const AFFECTED = ['TX-0029', 'TX-0042', 'TX-0063', 'TX-0071', 'TX-0088', 'TX-0101', 'TX-0104'];

// --- answer.txt ----------------------------------------------------------------
let answer;
try {
  answer = readFileSync('answer.txt', 'utf8');
} catch {
  fail('answer.txt is missing');
}
const listed = new Set(answer.split('\n').map((l) => l.trim().toUpperCase()).filter(Boolean));
const missing = AFFECTED.filter((id) => !listed.has(id));
const extra = [...listed].filter((id) => !AFFECTED.includes(id));
if (missing.length || extra.length) {
  fail(`answer.txt is wrong: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`);
}

// --- a correct reconciliation, for the generated dataset ------------------------
function reconcile(text) {
  const seen = new Set();
  const totals = {};
  for (const line of text.trim().split('\n').slice(1)) {
    const [rawId, account, rawAmount] = line.split(',');
    const id = rawId.trim().toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const amount = rawAmount.trim();
    const paren = /^\((.*)\)$/.exec(amount);
    const cents = paren ? -Math.round(Number(paren[1]) * 100) : Math.round(Number(amount) * 100);
    totals[account] = (totals[account] ?? 0) + cents;
  }
  return totals;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Another night's file with the same two anomalies (plus the harmless ones:
// exact re-sends, minus-sign refunds, distinct transactions with equal amounts),
// on different accounts and ids so nothing tuned to the shipped file carries over.
function anotherNight(seed) {
  const rand = mulberry32(seed);
  const accounts = ['HZ-301', 'HZ-302', 'HZ-303', 'HZ-304', 'HZ-305', 'HZ-306', 'HZ-307'];
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const money = (c) => (c / 100).toFixed(2);
  const base = [];
  for (let i = 0; i < 180; i++) {
    const cents = 100 + Math.floor(rand() * 90000);
    const r = rand();
    const amount = r < 0.08 ? money(-cents) : r < 0.16 ? `(${money(cents)})` : money(cents);
    const day = String(1 + Math.floor(i / 7)).padStart(2, '0');
    base.push({ id: `TX-${5000 + i}`, account: pick(accounts), amount, date: `2026-10-${day}` });
  }
  for (let k = 0; k < 4; k++) {
    const i = 10 + Math.floor(rand() * 160);
    base[i + 1] = { ...base[i], id: base[i + 1].id };
  }
  const rows = base.map((t) => ({ ...t }));
  const resend = (t, id) => {
    const at = rows.findIndex((r) => r.id === t.id) + 1 + Math.floor(rand() * 12);
    rows.splice(Math.min(at, rows.length), 0, { ...t, id });
  };
  const variants = [
    (id) => id.toLowerCase(),
    (id) => ' ' + id,
    (id) => id + ' ',
    (id) => '  ' + id.toLowerCase() + ' ',
    (id) => id[0] + id[1].toLowerCase() + id.slice(2),
  ];
  const parens = base.filter((t) => t.amount.startsWith('('));
  const minus = base.filter((t) => t.amount.startsWith('-'));
  const plain = base.filter((t) => !/^[-(]/.test(t.amount));
  const resent = [parens[0], parens[3], minus[1], ...Array.from({ length: 8 }, () => pick(plain))];
  resent.forEach((t, k) => resend(t, variants[k % variants.length](t.id)));
  for (let k = 0; k < 5; k++) {
    const t = pick(base);
    resend(t, t.id);
  }
  return ['id,account,amount,date', ...rows.map((r) => `${r.id},${r.account},${r.amount},${r.date}`)].join('\n') + '\n';
}

// --- run the job on a copy of the workspace, with a given transactions file ------
function runTotals(csvText) {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  try {
    cpSync('.', dir, {
      recursive: true,
      filter: (src) => !/(^|\/)(node_modules|\.git|\.agent)(\/|$)/.test(src),
    });
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'transactions.csv'), csvText);
    let out;
    try {
      out = execFileSync(process.execPath, ['src/totals.js'], { cwd: dir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return { error: (err.stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' | ') };
    }
    const totals = {};
    for (const line of out.split('\n')) {
      const m = /^\s*([^,\s]+)\s*[,\t ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
      if (m) totals[m[1]] = Math.round(Number(m[2]) * 100);
    }
    return { totals };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compare(label, { totals: got, error }, want) {
  if (error !== undefined) fail(`${label}: node src/totals.js failed: ${error}`);
  const fmt = (c) => (c === undefined ? 'missing' : (c / 100).toFixed(2));
  const off = [...new Set([...Object.keys(want), ...Object.keys(got)])]
    .sort()
    .filter((a) => got[a] !== want[a])
    .map((a) => `${a} got ${fmt(got[a])} want ${fmt(want[a])}`);
  if (off.length) fail(`${label}: totals still off — ${off.join('; ')}`);
}

const sorted = (o) => JSON.stringify(Object.entries(o).sort());
if (sorted(reconcile(ORIGINAL_CSV)) !== sorted(FINANCE)) fail('internal: reference reconciliation disagrees with finance');
compare('the shipped data/transactions.csv', runTotals(ORIGINAL_CSV), FINANCE);
const other = anotherNight(20261001);
compare("another night's transactions", runTotals(other), reconcile(other));

console.log('src/totals.js matches finance on this and another night, and answer.txt lists exactly the affected transactions');
