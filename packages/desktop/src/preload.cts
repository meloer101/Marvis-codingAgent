/**
 * What the page learns about the window it is in (`window.marvisDesktop`):
 * on a Mac there is no title bar — the window's buttons sit over the page's
 * top-left corner, except in full screen — so the page leaves them room and
 * lets its top rows move the window (packages/web/public/shell.js).
 *
 * CommonJS: a sandboxed preload can't be an ES module.
 */

import electron = require('electron');

electron.contextBridge.exposeInMainWorld('marvisDesktop', {
  platform: process.platform,
  titleBar: process.platform === 'darwin' ? 'inset' : 'native',
  onFullScreen(listener: (fullScreen: boolean) => void): void {
    electron.ipcRenderer.on('marvis:full-screen', (_event, fullScreen: boolean) => listener(fullScreen));
  },
});
