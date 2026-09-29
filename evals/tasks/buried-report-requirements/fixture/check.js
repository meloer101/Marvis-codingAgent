// Quick sanity check for out/report.json: it parses, it has days, and each
// day's info + warn + error adds up to its total. It doesn't know what the
// right numbers are, so passing it says little about whether the report is
// correct.
import { readFileSync } from 'node:fs';

let report;
try {
  report = JSON.parse(readFileSync('out/report.json', 'utf8'));
} catch (err) {
  console.log(`out/report.json is missing or not valid JSON: ${err.message}`);
  process.exit(1);
}

const days = Object.entries(report.days ?? {});
if (days.length === 0) {
  console.log('out/report.json has no days');
  process.exit(1);
}
for (const [day, c] of days) {
  if (c.info + c.warn + c.error !== c.total) {
    console.log(`${day}: info + warn + error does not add up to total`);
    process.exit(1);
  }
}
const entries = days.reduce((sum, [, c]) => sum + c.total, 0);
console.log(`OK: ${days.length} days, ${entries} entries`);
