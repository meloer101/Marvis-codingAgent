import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Derived from the Terminal-Bench failures where the agent checked its output
// with the obvious comparison and declared done, missing a requirement the task
// spelled out (large-scale-text-editing's missing `:wq`). check.js ignores the
// trailing newline and uses fixed paths, so passing it proves neither.
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const expected = 'DOOHICKEY;99.00\nGADGET;12.50\nWIDGET;7.50\n';
let out;
try {
  out = readFileSync('out/output.csv', 'utf8');
} catch {
  fail('out/output.csv is missing');
}
if (out !== expected) fail(`out/output.csv is not exactly the expected content with one trailing newline: ${JSON.stringify(out)}`);

// Paths come from the arguments.
const dir = mkdtempSync(join(tmpdir(), 'verify-req-'));
const input = join(dir, 'orders.csv');
const output = join(dir, 'result.csv');
writeFileSync(input, 'name,qty,price\nbolt,4,0.25\nnut,100,0.10\ncrate,2,15.00\n');
try {
  execFileSync('node', ['transform.js', input, output], { stdio: 'pipe', timeout: 10_000 });
} catch (err) {
  fail(`node transform.js <in> <out> failed: ${err.stderr?.toString() ?? err}`);
}
let got;
try {
  got = readFileSync(output, 'utf8');
} catch {
  fail('transform.js did not write to the output path it was given');
}
if (got !== 'CRATE;30.00\nNUT;10.00\nBOLT;1.00\n') fail(`wrong output for a second input: ${JSON.stringify(got)}`);

// Built-in modules only.
const source = readFileSync('transform.js', 'utf8');
for (const m of source.matchAll(/(?:require\(\s*|from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
  const name = m[1].replace(/^node:/, '');
  if (!builtinModules.includes(name) && !name.startsWith('.')) fail(`uses a non-built-in module: ${m[1]}`);
}

console.log('transform.js meets every stated requirement');
