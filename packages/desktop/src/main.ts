/**
 * Marvis as a desktop app: the `marvis web` server and its page in one window.
 * The main process hosts the server in-process — every project, remembered in
 * `~/.agent/web/workspaces.json` like `marvis web`'s — and the window shows the
 * same page a browser gets, through the same token-authenticated socket. Only
 * the folder chooser differs: Electron's own sheet instead of osascript.
 *
 * One server for every project, whichever started it: when a `marvis web` of
 * this version is already up, the window opens that one, and a `marvis web`
 * run later finds this app's server the same way (`server.json`).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';

import { VERSION } from '@harness-code/core';
import {
  clearInstance,
  fileWorkspaceStore,
  findRunningInstance,
  loadOrCreateToken,
  resolveStaticDir,
  startServer,
  webStateDir,
  workspacesFile,
  writeInstance,
} from '@harness-code/server';
import type { FolderPicker, RunningServer } from '@harness-code/server';

import { DEFAULT_PORT, isAppUrl, lastProject, pageUrl } from './launch.js';
import { backendDirs, sourceRoot, watchRebuilds } from './rebuilds.js';
import { readLoginShellEnv } from './shell-env.js';

interface Page {
  url: string;
  port: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** Next to this file: `dist/` in development, `dist/bundle/` in the app (scripts/package.mjs). */
const PRELOAD = join(HERE, 'preload.cjs');
/** The checkout this build sits in: development, or the app linked to it. Undefined in the packaged app. */
const SOURCE = sourceRoot(HERE);
/** The window's buttons, centred on the page's 44px top rows (preload.cts, shell.js). */
const TRAFFIC_LIGHTS = { x: 16, y: 16 };
/** How long quitting waits at most for the server to stop its sessions. */
const QUIT_GRACE_MS = 3000;

const stateDir = webStateDir();
let page: Page | null = null;
let mainWindow: BrowserWindow | null = null;
/** The server this app started; null when it opened one already running (or none yet). */
let server: RunningServer | null = null;
/** Whether `server.json` describes this app's server (it took the default port). */
let recorded = false;
let quitting = false;

app.setName('Marvis');
app.setAboutPanelOptions({ applicationName: 'Marvis', applicationVersion: VERSION });
// A development run (`pnpm desktop`) keeps its own Chromium profile, and with it its
// own single-instance lock: one left open must not stop the installed app from starting.
if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Marvis Dev'));

const folderDialog = (opts: OpenDialogOptions) => {
  const options: OpenDialogOptions = { ...opts, properties: ['openDirectory', 'createDirectory'] };
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
};

/** "Add project" in the page: a sheet on the window. */
const folderPicker = async (): Promise<FolderPicker> => ({
  async pick(prompt) {
    const result = await folderDialog({ title: prompt, message: prompt, buttonLabel: 'Add' });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
});

/** A first launch has no project to start the server with: ask for one. */
async function chooseFirstProject(): Promise<string | null> {
  const result = await folderDialog({
    title: 'Open a project',
    message: 'Choose a project folder to start with. Add more from the sidebar later.',
    buttonLabel: 'Open',
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** Open the running server, or start one; null when the user declined to pick a first project. */
async function connect(): Promise<Page | null> {
  const token = await loadOrCreateToken(stateDir);
  const running = await findRunningInstance(stateDir);
  if (running && running.version === VERSION) return { url: pageUrl(running.port, token), port: running.port };

  const store = fileWorkspaceStore(workspacesFile(stateDir));
  const cwd = (await lastProject(await store.load())) ?? (await chooseFirstProject());
  if (!cwd) return null;

  const start = (port: number) => startServer({ cwd, port, token, workspaceStore: store, folderPicker });
  try {
    server = await start(DEFAULT_PORT);
  } catch (err) {
    // Taken by something else (an older marvis web, another app): any free port will do.
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    server = await start(0);
  }
  recorded = server.port === DEFAULT_PORT;
  if (recorded) {
    await writeInstance(stateDir, {
      pid: process.pid,
      port: server.port,
      version: VERSION,
      bootId: server.bootId,
      cwd,
      startedAt: Date.now(),
    });
  }
  return { url: pageUrl(server.port, token), port: server.port };
}

/** Links out of the app open in the system browser; nothing else leaves it. */
function openOutside(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function createWindow(target: Page): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Marvis',
    show: false,
    // No title bar on a Mac: the window's buttons sit over the page's top-left corner.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, trafficLightPosition: TRAFFIC_LIGHTS } : {}),
    // The page's own background (DESIGN.md), so the window never flashes the other theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f11' : '#ffffff',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('preload-error', (_event, path, err) => console.error(`preload ${path} failed:`, err));
  // Full screen hides the window's buttons: the page takes back their corner.
  win.on('enter-full-screen', () => win.webContents.send('marvis:full-screen', true));
  win.on('leave-full-screen', () => win.webContents.send('marvis:full-screen', false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, target.port)) return;
    event.preventDefault();
    openOutside(url);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(target.url);
  return win;
}

/** Bring the window up, making it again if it was closed (the server keeps running meanwhile). */
function showWindow(): void {
  if (!page) return;
  if (!mainWindow) mainWindow = createWindow(page);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Running from a checkout, `pnpm build` shows up without reinstalling: a new
 * web bundle reloads the window, a new server build offers a restart (which
 * stops running sessions, so it is never done unasked).
 */
function followRebuilds(): void {
  watchRebuilds({
    webDir: resolveStaticDir(),
    // Only this app's own server can be restarted with it.
    backendDirs: server && SOURCE ? backendDirs(SOURCE) : [],
    onWeb: () => mainWindow?.webContents.reloadIgnoringCache(),
    onBackend: () => void offerRestart(),
  });
}

let offeringRestart = false;
async function offerRestart(): Promise<void> {
  if (offeringRestart || quitting) return;
  offeringRestart = true;
  const options = {
    type: 'info' as const,
    message: 'Marvis was rebuilt',
    detail: 'Restart to run the new build? Sessions that are running will stop.',
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  offeringRestart = false;
  if (response === 0) {
    app.relaunch();
    app.quit();
  }
}

/** A Finder-launched app has launchd's bare environment; take the login shell's (see shell-env.ts). */
async function adoptShellEnv(): Promise<void> {
  if (process.platform === 'win32') return;
  const env = await readLoginShellEnv();
  if (env) Object.assign(process.env, env);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // The Dock icon clicked with every window closed.
  app.on('activate', showWindow);
  // On a Mac the app — and the sessions its server runs — outlive the window.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // `kill` or Ctrl+C in the terminal of a development run: quit the usual way, server first.
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.on('will-quit', (event) => {
    if (!server || quitting) return;
    event.preventDefault();
    quitting = true;
    const closing = server;
    const closed = (recorded ? clearInstance(stateDir, process.pid) : Promise.resolve())
      .catch(() => {})
      .then(() => closing.close())
      .catch(() => {});
    // A server that won't wind down must not keep the app from quitting.
    void Promise.race([closed, new Promise((resolve) => setTimeout(resolve, QUIT_GRACE_MS))]).finally(() => {
      server = null;
      app.quit();
    });
  });

  // Not a top-level await: Electron emits `ready` only once this module has
  // finished evaluating, so awaiting it here would never return.
  void app.whenReady().then(async () => {
    await adoptShellEnv();
    try {
      page = await connect();
    } catch (err) {
      dialog.showErrorBox('Marvis could not start', err instanceof Error ? err.message : String(err));
    }
    if (!page) return app.quit();
    showWindow();
    followRebuilds();
  });
}
