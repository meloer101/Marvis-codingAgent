import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Derived from the failures where the agent verified its output with the
// obvious check (check.js only proves the counts add up) and declared done,
// missing requirements the prompt spelled out in prose: inclusive range, empty
// days kept, UTC-day bucketing, a `skipped` tally, errorRate as a rounded
// percentage (0 on empty days), chronological keys, paths from the arguments.
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const FIELDS = ['total', 'info', 'warn', 'error', 'errorRate'];

const SAMPLE = {
  skipped: 5,
  days: {
    '2026-09-01': { total: 24, info: 15, warn: 6, error: 3, errorRate: 12.5 },
    '2026-09-02': { total: 27, info: 17, warn: 5, error: 5, errorRate: 18.5 },
    '2026-09-03': { total: 26, info: 17, warn: 4, error: 5, errorRate: 19.2 },
    '2026-09-04': { total: 0, info: 0, warn: 0, error: 0, errorRate: 0 },
    '2026-09-05': { total: 22, info: 13, warn: 5, error: 4, errorRate: 18.2 },
    '2026-09-06': { total: 0, info: 0, warn: 0, error: 0, errorRate: 0 },
    '2026-09-07': { total: 25, info: 16, warn: 6, error: 3, errorRate: 12 },
  },
};

function compare(label, got, want) {
  if (typeof got !== 'object' || got === null) fail(`${label}: not a JSON object`);
  if (got.skipped !== want.skipped) fail(`${label}: skipped is ${JSON.stringify(got.skipped)}, expected ${want.skipped}`);
  if (typeof got.days !== 'object' || got.days === null) fail(`${label}: no "days" object`);
  const gotKeys = Object.keys(got.days).join(', ');
  const wantKeys = Object.keys(want.days).join(', ');
  if (gotKeys !== wantKeys) fail(`${label}: days are [${gotKeys}], expected [${wantKeys}] in that order`);
  for (const [day, counts] of Object.entries(want.days)) {
    for (const f of FIELDS) {
      const v = got.days[day]?.[f];
      if (v !== counts[f]) fail(`${label}: ${day}.${f} is ${JSON.stringify(v)}, expected ${counts[f]}`);
    }
  }
}

// The report must not depend on the machine's time zone: run under one far
// from UTC and from every offset in the logs.
const env = { ...process.env, TZ: 'Pacific/Honolulu' };
const work = mkdtempSync(join(tmpdir(), 'summarize-check-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

function run(label, log, from, to) {
  const out = join(work, `${label.replace(/\W+/g, '-')}.json`);
  try {
    execFileSync('node', ['summarize.js', log, from, to, out], { stdio: 'pipe', timeout: 15_000, env });
  } catch (err) {
    fail(`${label}: node summarize.js <log> ${from} ${to} <out> failed: ${err.stderr?.toString().trim() || err.message}`);
  }
  try {
    return JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    fail(`${label}: summarize.js did not write valid JSON to the output path it was given`);
  }
}

// A second log, built from UTC instants so the right answer is known by
// construction: another month, a range across Feb/Mar 2027 (not a leap year),
// an empty day inside it, lines exactly on the range edges, offsets the sample
// doesn't use, and unparseable lines of the same kinds.
function hiddenCase() {
  let seed = 424242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const OFFSETS = [
    ['+08:00', 480],
    ['-05:00', -300],
    ['Z', 0],
    ['+09:00', 540],
    ['-03:00', -180],
  ];
  const LEVELS = ['INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'WARN', 'ERROR'];
  const entries = [];
  const add = (ms, [off, mins], level) => {
    const local = new Date(ms + mins * 60_000).toISOString().slice(0, 19);
    entries.push({ ms, level, text: `${local}${off} ${level} job=${Math.floor(rnd() * 1e6)} done` });
  };
  const spread = [
    ['2027-02-25', 5],
    ['2027-02-26', 9],
    ['2027-02-27', 13],
    ['2027-03-01', 11],
    ['2027-03-02', 8],
    ['2027-03-03', 5],
  ];
  for (const [day, n] of spread) {
    const base = Date.parse(`${day}T00:00:00Z`);
    for (let i = 0; i < n; i++) {
      add(base + Math.floor(rnd() * 86_400) * 1000, OFFSETS[Math.floor(rnd() * OFFSETS.length)], LEVELS[Math.floor(rnd() * LEVELS.length)]);
    }
  }
  add(Date.parse('2027-02-26T00:00:00Z'), OFFSETS[0], 'ERROR'); // 08:00+08:00, first second of the range
  add(Date.parse('2027-02-25T23:59:59Z'), OFFSETS[4], 'ERROR'); // just before it
  add(Date.parse('2027-03-02T23:59:59Z'), OFFSETS[3], 'WARN'); // 03-03 local, last second of the range
  add(Date.parse('2027-03-03T00:00:00Z'), OFFSETS[1], 'ERROR'); // 03-02 local, just after it
  entries.sort((a, b) => a.ms - b.ms);

  const lines = entries.map((e) => e.text);
  lines.splice(7, 0, '    at Scheduler.run (lib/scheduler.js:120:9)');
  lines.splice(20, 0, '2027-02-27T10:00:00+09:00 job=1 done');
  lines.splice(33, 0, '2027-03-01T0');
  lines.splice(41, 0, '-- worker-3 draining --');

  const from = '2027-02-26';
  const to = '2027-03-02';
  const days = {};
  for (const d of ['2027-02-26', '2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02']) {
    days[d] = { total: 0, info: 0, warn: 0, error: 0, errorRate: 0 };
  }
  for (const e of entries) {
    const d = days[new Date(e.ms).toISOString().slice(0, 10)];
    if (!d) continue;
    d.total++;
    d[e.level.toLowerCase()]++;
  }
  for (const d of Object.values(days)) {
    if (d.total === 0) continue;
    const r10 = (d.error / d.total) * 1000;
    if (Math.abs(r10 - Math.floor(r10) - 0.5) < 0.01) fail('assert.mjs bug: hidden case has a rounding tie');
    d.errorRate = Math.round(r10) / 10;
  }
  return { log: `${lines.join('\n')}\n`, from, to, want: { skipped: 4, days } };
}

// 1. The deliverable left in the workspace.
let report;
try {
  report = JSON.parse(readFileSync('out/report.json', 'utf8'));
} catch {
  fail('out/report.json is missing or not valid JSON');
}
compare('out/report.json', report, SAMPLE);

// 2. summarize.js itself reproduces it, paths from the arguments.
compare('summarize.js on the sample log', run('sample', join(process.cwd(), 'logs/app-2026-09.txt'), '2026-09-01', '2026-09-07'), SAMPLE);

// 3. A second log it has never seen.
const hidden = hiddenCase();
const log = join(work, 'service-2027-02.txt');
writeFileSync(log, hidden.log);
compare(`summarize.js on a second log (${hidden.from}..${hidden.to})`, run('hidden', log, hidden.from, hidden.to), hidden.want);

console.log('summarize.js meets every stated requirement');
