/**
 * Build Marvis.app for this Mac, one of two ways:
 *
 * - **Standalone** (`pnpm release:desktop`, the default): the desktop main
 *   process bundled into one file with the server, the web UI, the builtin
 *   skills/agents/memory and node-pty, wrapped in Electron, plus a .dmg — an
 *   app that needs nothing else, to hand to someone.
 *
 *   The app directory mirrors the published `marvis` package (scripts/bundle-marvis.mjs):
 *   the bundle sits at `dist/bundle/main.mjs`, so the server finds the web UI in
 *   `dist/bundle/web/` (packages/server/src/http.ts) and core finds `skills/`,
 *   `agents/` and `memory/` at `../../` (packages/core/src/skills/discover.ts).
 *   No asar: skills may ship scripts the agent runs, and a child process can't
 *   read inside an archive.
 *
 * - **Linked** (`pnpm desktop:install`, `--link`): Electron and a two-line entry
 *   that runs this checkout's build (`packages/desktop/dist/main.js`) — what
 *   the `marvis` alias is to the CLI. `pnpm build` is all an update takes: the
 *   window reloads on a new web bundle and offers a restart on a new server
 *   build (src/rebuilds.ts). Moving or deleting the checkout breaks it.
 *
 * `--install` then puts the app in /Applications, replacing the one there (a
 * running one keeps running the old files until it is restarted).
 *
 * Unsigned by a Developer ID: the app is signed ad hoc, which runs on the Mac
 * that built it. Copied to another Mac, Gatekeeper asks first (right-click › Open).
 *
 * Prerequisite: `pnpm build`.
 * Output: `release-desktop/Marvis-darwin-<arch>/Marvis.app` and `release-desktop/Marvis-<version>-<arch>.dmg`,
 * or `release-desktop/linked/Marvis-darwin-<arch>/Marvis.app`.
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { packager } from '@electron/packager';
import { build } from 'esbuild';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const root = resolve(desktop, '../..');
const linked = process.argv.includes('--link');
const install = process.argv.includes('--install');
const outDir = resolve(root, linked ? 'release-desktop/linked' : 'release-desktop');
const appDir = resolve(outDir, 'app');
const arch = process.arch;

if (process.platform !== 'darwin') throw new Error('Marvis.app is built on a Mac');

/** Single source of truth for the version: the runtime VERSION constant. */
async function readVersion() {
  const src = await readFile(resolve(root, 'packages/core/src/version.ts'), 'utf8');
  const m = src.match(/VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('Could not read VERSION from packages/core/src/version.ts');
  return m[1];
}

/** `build/icon.svg` → an .icns, through Quick Look (renders SVG), sips and iconutil — all built into macOS. */
async function makeIcon(work) {
  await run('qlmanage', ['-t', '-s', '1024', '-o', work, resolve(desktop, 'build/icon.svg')]);
  const png = join(work, 'icon.svg.png');
  const iconset = join(work, 'icon.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await run('sips', ['-z', String(size), String(size), png, '--out', join(iconset, `icon_${size}x${size}.png`)]);
    await run('sips', ['-z', String(size * 2), String(size * 2), png, '--out', join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  const icns = join(work, 'icon.icns');
  await run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  return icns;
}

/** Everything the app runs, in `appDir`; the entry is `dist/bundle/main.mjs`. */
async function assembleStandalone() {
  const bundleDir = resolve(appDir, 'dist/bundle');
  const webDist = resolve(root, 'packages/web/dist');
  if (!existsSync(webDist)) throw new Error('packages/web/dist is missing — run `pnpm build` first');
  await mkdir(bundleDir, { recursive: true });

  await build({
    entryPoints: [resolve(desktop, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: resolve(bundleDir, 'main.mjs'),
    // Electron is the runtime; node-pty is native and copied in below.
    external: ['electron', 'node-pty'],
    // Some transitive deps use CJS `require` at runtime; give the ESM output one.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'info',
  });

  // The window's preload, beside main.mjs where main looks for it: CommonJS, as a sandboxed preload must be.
  await build({
    entryPoints: [resolve(desktop, 'src/preload.cts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: resolve(bundleDir, 'preload.cjs'),
    external: ['electron'],
    logLevel: 'info',
  });

  await cp(webDist, resolve(bundleDir, 'web'), { recursive: true });
  for (const dir of ['skills', 'agents', 'memory']) {
    const from = resolve(root, 'packages/core', dir);
    if (existsSync(from)) await cp(from, resolve(appDir, dir), { recursive: true });
  }

  // node-pty, as its prebuilt binary for this Mac (N-API: the same build loads in
  // Node and in Electron). Only what it loads at runtime.
  const pty = realpathSync(resolve(root, 'packages/server/node_modules/node-pty'));
  const ptyOut = resolve(appDir, 'node_modules/node-pty');
  await cp(join(pty, 'package.json'), join(ptyOut, 'package.json'));
  await cp(join(pty, 'lib'), join(ptyOut, 'lib'), { recursive: true });
  await cp(join(pty, `prebuilds/darwin-${arch}`), join(ptyOut, `prebuilds/darwin-${arch}`), { recursive: true });
  return 'dist/bundle/main.mjs';
}

/** An entry that runs this checkout's build, in `appDir`. */
async function assembleLinked() {
  const main = resolve(desktop, 'dist/main.js');
  if (!existsSync(main)) throw new Error(`${main} is missing — run \`pnpm build\` first`);
  await mkdir(appDir, { recursive: true });
  const entry = `// Marvis linked to the checkout at ${root}: it runs that checkout's build,
// so \`pnpm build\` there is all an update takes (packages/desktop/scripts/package.mjs).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { app, dialog } from 'electron';

const main = ${JSON.stringify(main)};
if (existsSync(main)) {
  await import(pathToFileURL(main).href);
} else {
  void app.whenReady().then(() => {
    dialog.showErrorBox('Marvis has no build to run', \`\${main} is missing. Run pnpm build in ${root}.\`);
    app.quit();
  });
}
`;
  await writeFile(resolve(appDir, 'main.mjs'), entry);
  return 'main.mjs';
}

const version = await readVersion();
await rm(outDir, { recursive: true, force: true });
const main = linked ? await assembleLinked() : await assembleStandalone();
await writeFile(
  resolve(appDir, 'package.json'),
  `${JSON.stringify({ name: 'marvis', productName: 'Marvis', version, type: 'module', main }, null, 2)}\n`,
);

const work = await mkdtemp(join(tmpdir(), 'marvis-desktop-'));
try {
  const icon = await makeIcon(work);
  const electronVersion = JSON.parse(await readFile(resolve(desktop, 'node_modules/electron/package.json'), 'utf8')).version;
  const [appPath] = await packager({
    dir: appDir,
    out: outDir,
    name: 'Marvis',
    platform: 'darwin',
    arch,
    electronVersion,
    icon,
    appBundleId: 'dev.marvis.desktop',
    appVersion: version,
    appCategoryType: 'public.app-category.developer-tools',
    darwinDarkModeSupport: true,
    asar: false,
    prune: false,
    overwrite: true,
  });
  const app = join(appPath, 'Marvis.app');
  await run('codesign', ['--force', '--deep', '--sign', '-', app]);
  console.log(`built ${app}${linked ? ` (runs ${root})` : ''}`);

  if (!linked) {
    // A disk image with the usual "drag to Applications" layout.
    const stage = join(work, 'dmg');
    await mkdir(stage);
    await run('ditto', [app, join(stage, 'Marvis.app')]); // keeps the frameworks' symlinks and signatures
    await symlink('/Applications', join(stage, 'Applications'));
    const dmg = resolve(outDir, `Marvis-${version}-${arch}.dmg`);
    await run('hdiutil', ['create', '-volname', 'Marvis', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
    console.log(`built ${dmg}`);
  }

  if (install) {
    const target = '/Applications/Marvis.app';
    await rm(target, { recursive: true, force: true });
    await run('ditto', [app, target]);
    console.log(`installed ${target}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
