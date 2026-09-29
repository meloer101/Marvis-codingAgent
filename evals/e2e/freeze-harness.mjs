#!/usr/bin/env node
// Freeze the hc build a variant is measured on:
//
//   node evals/e2e/freeze-harness.mjs --variant baseline [--commit <rev>] [--flow DIR]
//   node evals/e2e/freeze-harness.mjs --variant v1 --from-worktree
//
// Exports the source (a commit via `git archive`, or the working tree's
// tracked + untracked-but-not-ignored files), installs dependencies offline from
// the repo's .pnpm-store, compiles the workspace packages and bundles hc into one
// file: <flow>/<variant>/harness/hc.mjs, with harness.json recording where it
// came from. run-eval.mjs runs that file for every case of the variant, so a
// rebuild of packages/ in the repo (by you or another session) can't change
// what a pass measures halfway through.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = { flow: '.claude/hillclimb/coding-e2e', variant: undefined, commit: 'HEAD', fromWorktree: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '--flow') args.flow = argv[++i];
  else if (k === '--variant') args.variant = argv[++i];
  else if (k === '--commit') args.commit = argv[++i];
  else if (k === '--from-worktree') args.fromWorktree = true;
  else { console.error(`unknown argument: ${k}`); process.exit(2); }
}
if (!/^(baseline|v[1-9]\d*)$/.test(args.variant ?? '')) { console.error('--variant must be baseline or v<N>'); process.exit(2); }

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const run = (cmd, a, cwd) => execFileSync(cmd, a, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

const outDir = resolve(REPO, args.flow, args.variant, 'harness');
if (existsSync(join(outDir, 'hc.mjs'))) {
  console.error(`${outDir}/hc.mjs already exists - a variant's harness is frozen once; delete it deliberately to rebuild`);
  process.exit(2);
}

const commit = git('rev-parse', args.commit);
const src = mkdtempSync(join(tmpdir(), 'hc-freeze-'));
let dirty = null;
try {
  if (args.fromWorktree) {
    // Tracked files plus untracked-but-not-ignored ones, as they are on disk now.
    execFileSync('sh', ['-c', `cd "${REPO}" && git ls-files -co --exclude-standard -z | tar -cf - --null -T - | tar -xf - -C "${src}"`]);
    const diff = git('diff', 'HEAD', '--', 'packages');
    dirty = { diff_sha256: createHash('sha256').update(diff).digest('hex'), changed: git('diff', 'HEAD', '--stat', '--', 'packages').split('\n').slice(0, -1) };
  } else {
    execFileSync('sh', ['-c', `git -C "${REPO}" archive ${commit} | tar -xf - -C "${src}"`]);
  }
  run('pnpm', ['install', '--offline', '--frozen-lockfile', '--store-dir', join(REPO, '.pnpm-store')], src);
  run('npx', ['tsc', '-b'], src);
  run('node', ['scripts/bundle-hc.mjs'], src);
  const bundle = join(src, 'dist-bundle', 'hc.mjs');
  const version = run('node', [bundle, '--version'], src).trim();
  mkdirSync(outDir, { recursive: true });
  copyFileSync(bundle, join(outDir, 'hc.mjs'));
  const sha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  const info = { commit, commit_subject: git('log', '-1', '--format=%s', commit), from_worktree: args.fromWorktree,
    ...(dirty ? { worktree_changes: dirty } : {}), hc_version: version, sha256, built_at: new Date().toISOString(), node: process.version };
  writeFileSync(join(outDir, 'harness.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`froze hc ${version} @ ${commit.slice(0, 7)}${args.fromWorktree ? ' + working-tree changes' : ''} -> ${join(outDir, 'hc.mjs')} (sha256 ${sha256.slice(0, 12)})`);
} finally {
  rmSync(src, { recursive: true, force: true });
}
