import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { useSync } from '@/lib/syncContext';

/**
 * One terminal's screen (xterm.js — loaded with this module, on first use):
 * fed from the server's stream, typing and size sent back. It stays mounted
 * while its tab is hidden, so the scrollback stays too.
 */
export function XTermView({ id, visible, onTitle }: { id: string; visible: boolean; onTitle: (title: string) => void }) {
  const sync = useSync();
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fitRef.current = { term, fit };
    // Ctrl+` belongs to the app (it hides the panel); everything else is the shell's.
    term.attachCustomKeyEventHandler((e) => !(e.ctrlKey && e.code === 'Backquote'));

    const exited = (code: number): void => term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    const detach = sync.attachTerminal(id, {
      onReset(scrollback, exitCode) {
        term.reset();
        term.write(scrollback);
        if (exitCode !== undefined) exited(exitCode);
      },
      onData: (data) => term.write(data),
      onExit: exited,
      onGone: () => term.write('\r\n\x1b[2m[this terminal is gone]\x1b[0m\r\n'),
    });
    const input = term.onData((data) => sync.terminalInput(id, data));
    const resize = term.onResize(({ cols, rows }) => sync.terminalResize(id, cols, rows));
    const title = term.onTitleChange((t) => titleRef.current(t));

    // Follow the panel's size, and the theme (a class on <html>).
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) fit.fit();
    });
    ro.observe(el);
    const mo = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      ro.disconnect();
      mo.disconnect();
      input.dispose();
      resize.dispose();
      title.dispose();
      detach();
      term.dispose();
      fitRef.current = null;
    };
  }, [sync, id]);

  // A tab coming into view measures itself and takes the keyboard.
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    const { term, fit } = fitRef.current;
    fit.fit();
    term.focus();
  }, [visible]);

  return <div ref={host} className="absolute inset-0 px-2 pt-1" style={{ display: visible ? 'block' : 'none' }} />;
}

/** The app's palette as an xterm theme: xterm wants sRGB, the tokens are OKLCH. */
function terminalTheme(): ITheme {
  const c = (token: string): string => tokenColor(token);
  const ansi = (n: number): string => c(`--ansi-${n}`);
  return {
    background: c('--background'),
    foreground: c('--foreground'),
    cursor: c('--primary'),
    cursorAccent: c('--background'),
    selectionBackground: c('--selection'),
    black: ansi(0),
    red: ansi(1),
    green: ansi(2),
    yellow: ansi(3),
    blue: ansi(4),
    magenta: ansi(5),
    cyan: ansi(6),
    white: ansi(7),
    brightBlack: c('--muted-foreground'),
    brightRed: ansi(1),
    brightGreen: ansi(2),
    brightYellow: ansi(3),
    brightBlue: ansi(4),
    brightMagenta: ansi(5),
    brightCyan: ansi(6),
    brightWhite: c('--foreground'),
  };
}

let canvas: CanvasRenderingContext2D | null | undefined;

/** A CSS custom property's colour as `rgb(…)` / `rgba(…)`, by painting a pixel with it. */
function tokenColor(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  canvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!canvas || !value) return value || '#000000';
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = value;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${((a ?? 0) / 255).toFixed(3)})`;
}
