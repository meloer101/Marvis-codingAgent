import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

// The test file must be untouched.
if (!readFileSync('test/temperature.test.mjs', 'utf8').includes('the two conversions round-trip')) {
  console.error('test/temperature.test.mjs was modified');
  process.exit(1);
}

// Plan mode must have produced a plan: `exit_plan_mode` writes it under .agent/plans.
let plans = [];
try {
  plans = readdirSync('.agent/plans').filter((f) => f.endsWith('.md'));
} catch {
  console.error('no .agent/plans directory — exit_plan_mode never ran');
  process.exit(1);
}
if (plans.length === 0) {
  console.error('.agent/plans is empty — exit_plan_mode never ran');
  process.exit(1);
}

// And the approved plan must actually have been implemented.
try {
  execFileSync('node', ['--test'], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
