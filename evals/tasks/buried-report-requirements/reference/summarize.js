import { readFileSync, writeFileSync } from 'node:fs';

const [logFile, from, to, outFile] = process.argv.slice(2);
if (!logFile || !from || !to || !outFile) {
  console.error('usage: node summarize.js <log file> <from> <to> <out.json>');
  process.exit(2);
}

const DAY_MS = 86_400_000;
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) (INFO|WARN|ERROR) /;

const days = {};
for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
  days[new Date(t).toISOString().slice(0, 10)] = { total: 0, info: 0, warn: 0, error: 0, errorRate: 0 };
}

let skipped = 0;
for (const line of readFileSync(logFile, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const m = LINE.exec(line);
  const time = m ? Date.parse(m[1]) : NaN;
  if (Number.isNaN(time)) {
    skipped++;
    continue;
  }
  const day = days[new Date(time).toISOString().slice(0, 10)];
  if (!day) continue;
  day.total++;
  day[m[2].toLowerCase()]++;
}

for (const day of Object.values(days)) {
  if (day.total > 0) day.errorRate = Math.round((day.error / day.total) * 1000) / 10;
}

writeFileSync(outFile, `${JSON.stringify({ skipped, days }, null, 2)}\n`);
