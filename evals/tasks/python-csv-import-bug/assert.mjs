import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Hidden end-state check: load_items returns exactly the right items for the
// old export, the new export (BOM, CRLF, quoted commas, doubled quotes), and an
// unseen file with the same features plus a trailing blank line; the CLI imports
// the new export; the existing tests still pass.

const FIXTURE_TEST_COUNT = 5;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
const python = (args, extra = {}) => spawnSync('python3', args, { encoding: 'utf8', timeout: 20_000, env, ...extra });

const dir = mkdtempSync(join(tmpdir(), 'inventory-assert-'));
const dump = join(dir, 'dump.py');
writeFileSync(
  dump,
  `import json, os, sys
sys.path.insert(0, os.getcwd())
from inventory.importer import load_items

def fields(item):
    get = (lambda k: item[k]) if isinstance(item, dict) else (lambda k: getattr(item, k))
    qty = get("qty")
    return [get("sku"), get("name"), qty if type(qty) is int else "not an int: " + repr(qty), str(get("unit_price")), get("bin")]

out = {}
for path in sys.argv[1:]:
    try:
        out[path] = [fields(item) for item in load_items(path)]
    except Exception as err:
        out[path] = "raised " + type(err).__name__ + ": " + str(err)
print(json.dumps(out))
`,
);

const hidden = join(dir, 'supplier_2026-10.csv');
writeFileSync(
  hidden,
  '﻿sku,name,qty,unit_price,bin\r\n' +
    'H-900,"Hinge, brass ""heavy duty""",12,3.75,B2\r\n' +
    'H-901,Plain hinge,0,1.10,B2\r\n' +
    'H-902,"Bracket 90°, zinc",7,0.95,C1\r\n' +
    'H-903,"Shelf pin",150,0.04,C1\r\n' +
    'H-904,"Cabinet ""soft close"" damper",8,4.20,D3\r\n' +
    '\r\n',
);

const expected = {
  'samples/supplier_2026-06.csv': [
    ['B-1001', 'Hex bolt M8', 250, '0.18', 'A1'],
    ['B-1002', 'Hex nut M8', 400, '0.05', 'A1'],
    ['W-2200', 'Widget small', 40, '6.75', 'A3'],
    ['W-2201', 'Widget medium', 25, '9.20', 'A3'],
    ['P-0410', '1/2in copper pipe', 60, '2.95', 'C1'],
    ['T-3300', 'Teflon tape', 120, '0.80', 'C2'],
    ['G-5000', 'Rubber gasket 40mm', 75, '0.42', 'B4'],
  ],
  'samples/supplier_2026-09.csv': [
    ['B-1001', 'Hex bolt M8', 300, '0.18', 'A1'],
    ['B-1002', 'Hex nut M8', 380, '0.05', 'A1'],
    ['W-2200', 'Widget small', 35, '6.75', 'A3'],
    ['W-2210', 'Widget, large', 12, '14.50', 'A3'],
    ['P-0410', '1/2in copper pipe', 48, '2.95', 'C1'],
    ['P-0412', '12" pipe', 20, '3.40', 'C1'],
    ['H-0716', 'Clamp, 2" hose', 64, '0.65', 'C2'],
    ['T-3300', 'Teflon tape', 90, '0.85', 'C2'],
  ],
  [hidden]: [
    ['H-900', 'Hinge, brass "heavy duty"', 12, '3.75', 'B2'],
    ['H-901', 'Plain hinge', 0, '1.10', 'B2'],
    ['H-902', 'Bracket 90°, zinc', 7, '0.95', 'C1'],
    ['H-903', 'Shelf pin', 150, '0.04', 'C1'],
    ['H-904', 'Cabinet "soft close" damper', 8, '4.20', 'D3'],
  ],
};

const run = python([dump, ...Object.keys(expected)]);
if (run.status !== 0) fail(`load_items could not be called: ${run.stderr.trim().split('\n').slice(-3).join(' | ')}`);
let got;
try {
  got = JSON.parse(run.stdout);
} catch {
  fail(`unexpected output from the load_items probe: ${run.stdout.slice(0, 200)}`);
}
for (const [path, want] of Object.entries(expected)) {
  const label = path === hidden ? 'an unseen export with the same format' : path;
  if (!isDeepStrictEqual(got[path], want)) {
    fail(`load_items(${label}) = ${JSON.stringify(got[path]).slice(0, 400)}, want ${JSON.stringify(want).slice(0, 400)}`);
  }
}

const cli = python(['-m', 'inventory.cli', 'import', 'samples/supplier_2026-09.csv']);
if (cli.status !== 0) fail(`the CLI exits ${cli.status} on the new export: ${cli.stderr.trim().split('\n').slice(-2).join(' | ')}`);
for (const name of ['Widget, large', '12" pipe', 'Clamp, 2" hose']) {
  if (!cli.stdout.includes(name)) fail(`the CLI summary for the new export does not show ${JSON.stringify(name)}`);
}

const tests = python(['-m', 'unittest']);
const ran = Number(/^Ran (\d+) tests?/m.exec(tests.stderr)?.[1] ?? NaN);
if (tests.status !== 0) fail(`python3 -m unittest fails: ${tests.stderr.trim().split('\n').slice(-4).join(' | ')}`);
if (!(ran >= FIXTURE_TEST_COUNT)) fail(`python3 -m unittest ran ${ran} tests; the project had ${FIXTURE_TEST_COUNT}`);

console.log(`both exports and an unseen one import correctly; ${ran} tests pass`);
