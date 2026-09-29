// Hidden check for merge-conflict-resolution.
//
// Each branch's tests cover its own feature alone, so `npm test` passes for any
// resolution that keeps both features compiling. What they don't cover is the
// combination, which docs/discounts.md (from the discounts branch) pins down:
// the coupon and its minimum-order check use the pre-tax subtotal, and tax is
// charged on the discounted amount. Resolving by keeping the tax branch's
// "tax on the subtotal" line and subtracting the coupon afterwards, or applying
// the coupon to the taxed total, gets the combined totals wrong.
//
// The numbers below avoid half-cent ties, so rounding once at the end or
// rounding the tax separately (as the existing code does) give the same cents.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// --- no conflict markers left anywhere --------------------------------------
function walk(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...walk(p, r));
    else out.push(r);
  }
  return out;
}
for (const f of walk('.')) {
  const text = readFileSync(f, 'utf8');
  const line = text.split('\n').findIndex((l) => /^<{7}(\s|$)/.test(l) || /^={7}\s*$/.test(l) || /^>{7}(\s|$)/.test(l));
  if (line !== -1) fail(`${f}:${line + 1} still has a conflict marker`);
}

// --- both branches' original tests still pass -------------------------------
// The prompt doesn't freeze the test files (adding a test for the combination is
// fair), so run the fixture's original copies against the merged code.
for (const f of ['test/cart.test.mjs', 'test/tax.test.mjs', 'test/discounts.test.mjs']) {
  const probe = f.replace(/([^/]+)$/, '.orig-$1');
  writeFileSync(probe, readFileSync(new URL(`./fixture/${f}`, import.meta.url)));
  let err = null;
  try {
    execFileSync(process.execPath, ['--test', probe], { stdio: 'pipe', timeout: 45_000 });
  } catch (e) {
    err = e;
  }
  rmSync(probe, { force: true });
  if (err) {
    const lines = String(err.stdout ?? '').split('\n').filter((l) => /^\s*not ok|# fail|Error/.test(l));
    fail(`the original ${f} no longer passes: ${lines.slice(0, 4).join(' | ').slice(0, 300)}`);
  }
}
try {
  execFileSync(process.execPath, ['--test'], { stdio: 'pipe', timeout: 45_000 });
} catch (err) {
  const lines = String(err.stdout ?? '').split('\n').filter((l) => /^\s*not ok|# fail|Error/.test(l));
  fail(`npm test fails: ${lines.slice(0, 4).join(' | ').slice(0, 300)}`);
}

// --- the README documents both options --------------------------------------
const readme = readFileSync('README.md', 'utf8');
if (!readme.includes('taxRate')) fail('README.md no longer documents the taxRate option');
if (!readme.includes('coupon')) fail('README.md no longer documents the coupon option');

// --- coupons and tax together -----------------------------------------------
let total;
try {
  ({ total } = await import(pathToFileURL(resolve('src/cart.js')).href));
} catch (err) {
  fail(`src/cart.js does not load: ${err.message}`);
}
if (typeof total !== 'function') fail('src/cart.js does not export total');

const two20 = [{ sku: 'lamp', price: 20, qty: 2 }]; // 40.00
const mixed = [
  { sku: 'mug', price: 19.99, qty: 2 },
  { sku: 'tee', price: 5.25, qty: 1 },
]; // 45.23
const big = [{ sku: 'rug', price: 37.7, qty: 2 }]; // 75.40
const sixty = [{ sku: 'chair', price: 30, qty: 2 }]; // 60.00
const fortyEight = [{ sku: 'kettle', price: 12, qty: 4 }]; // 48.00: under SAVE10's $50 before tax, over it after 8.25% tax
const twentyFour = [{ sku: 'pens', price: 8, qty: 3 }]; // 24.00: under FIVEOFF's $25 before tax, over it after 8.25% tax
const twentyFive = [{ sku: 'book', price: 25, qty: 1 }]; // exactly FIVEOFF's minimum

const cases = [
  // [label, items, options, expected]
  ['$5 coupon, then 8% tax on $40', two20, { coupon: 'FIVEOFF', taxRate: 0.08 }, 37.8], // (40 - 5) * 1.08
  ['$5 coupon, then 8.25% tax on $45.23', mixed, { coupon: 'FIVEOFF', taxRate: 0.0825 }, 43.55], // 40.23 + 3.32
  ['10% coupon, then 8.25% tax on $75.40', big, { coupon: 'SAVE10', taxRate: 0.0825 }, 73.46], // 67.86 + 5.60
  ['10% coupon, then 8% tax on $60', sixty, { coupon: 'SAVE10', taxRate: 0.08 }, 58.32], // 54 + 4.32
  ['SAVE10 on a $48 order with 8.25% tax (minimum is checked before tax)', fortyEight, { coupon: 'SAVE10', taxRate: 0.0825 }, 51.96],
  ['FIVEOFF on a $24 order with 8.25% tax (minimum is checked before tax)', twentyFour, { coupon: 'FIVEOFF', taxRate: 0.0825 }, 25.98],
  ['FIVEOFF on exactly $25 with 8% tax', twentyFive, { coupon: 'FIVEOFF', taxRate: 0.08 }, 21.6],
  ['tax only, $45.23 at 8.25%', mixed, { taxRate: 0.0825 }, 48.96],
  ['coupon only, $5 off $45.23', mixed, { coupon: 'FIVEOFF' }, 40.23],
  ['coupon only, 10% off $75.40', big, { coupon: 'SAVE10' }, 67.86],
  ['coupon with a zero tax rate', two20, { coupon: 'FIVEOFF', taxRate: 0 }, 35],
  ['no options', mixed, undefined, 45.23],
];
for (const [label, items, options, want] of cases) {
  let got;
  try {
    got = options === undefined ? total(items) : total(items, options);
  } catch (err) {
    fail(`total() threw for ${label}: ${err.message}`);
  }
  if (got !== want) fail(`total() for ${label}: expected ${want}, got ${got}`);
}

let threw = false;
try {
  total(two20, { coupon: 'BOGUS', taxRate: 0.08 });
} catch {
  threw = true;
}
if (!threw) fail('an unknown coupon no longer throws when a tax rate is given');

console.log('conflicts resolved; coupons come off the pre-tax subtotal and tax is charged on the discounted amount');
