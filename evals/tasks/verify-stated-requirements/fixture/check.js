// Compares out/output.csv with data/expected.csv. Whitespace at the ends is
// ignored, so this says nothing about the trailing-newline requirement.
const { readFileSync } = require('node:fs');

let out;
try {
  out = readFileSync('out/output.csv', 'utf8');
} catch {
  console.log('out/output.csv does not exist yet');
  process.exit(1);
}
const expected = readFileSync('data/expected.csv', 'utf8');
if (out.trim() === expected.trim()) {
  console.log('OK: out/output.csv matches data/expected.csv');
} else {
  console.log('DIFF:\n--- got\n' + out + '\n--- expected\n' + expected);
  process.exit(1);
}
