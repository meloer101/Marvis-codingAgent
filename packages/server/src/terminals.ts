/**
 * Terminals for the web UI: the user's own shell in a workspace's root, on a
 * pseudo-terminal (node-pty, an optional dependency — without it there are
 * no terminals, and `server.info.capabilities.terminal` says so).
 *
 * A terminal belongs to the server, not to a socket: a tab that drops and
 * reconnects attaches again and gets what was kept of the output (the last
 * `SCROLLBACK_CHARS`) before the live stream. Output is gathered for a few
 * milliseconds before it goes out, so a burst is one frame, not hundreds.
 * The shell is not sandboxed — it is the user's terminal, as powerful as the
 * token that reaches it.
 */

import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';

import type { TerminalInfo } from '@harness-code/protocol';

import { InvalidRequestError } from './host.js';

/** What we use of a node-pty process. */
export interface Pty {
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type SpawnPty = (
  shell: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => Pty;

/** node-pty's `spawn`, or null when it can't be loaded here. */
export async function loadPty(): Promise<SpawnPty | null> {
  try {
    const pty = (await import('node-pty')) as unknown as { spawn: SpawnPty; default?: { spawn: SpawnPty } };
    return pty.spawn ?? pty.default?.spawn ?? null;
  } catch {
    return null;
  }
}

/** How much output a terminal keeps for a tab that attaches later. */
export const SCROLLBACK_CHARS = 256 * 1024;
/** How long output gathers before it is sent. */
const FLUSH_MS = 8;

/** A terminal this server doesn't have. The WS layer maps it to `not_found`. */
export class TerminalNotFoundError extends Error {
  constructor(id: string) {
    super(`no terminal "${id}"`);
    this.name = 'TerminalNotFoundError';
  }
}

/** What a socket attached to a terminal receives. */
export type TerminalListener = (out: { data: string } | { exitCode: number }) => void;

/** The user's shell, as a login shell where that is how it starts on a desktop. */
export function userShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { shell: string; args: string[] } {
  if (platform === 'win32') return { shell: env['COMSPEC'] ?? 'powershell.exe', args: [] };
  const shell = env['SHELL'] || '/bin/bash';
  return { shell, args: ['bash', 'zsh', 'fish', 'sh', 'ksh'].includes(basename(shell)) ? ['-l'] : [] };
}

class Terminal {
  readonly info: TerminalInfo;
  readonly #pty: Pty;
  #kept: string[] = [];
  #keptChars = 0;
  #pending = '';
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #listeners = new Set<TerminalListener>();

  constructor(info: TerminalInfo, pty: Pty, onExit: () => void) {
    this.info = info;
    this.#pty = pty;
    pty.onData((data) => {
      this.#pending += data;
      this.#timer ??= setTimeout(() => this.#flush(), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      this.#flush();
      this.info.exitCode = exitCode;
      for (const l of this.#listeners) l({ exitCode });
      onExit();
    });
  }

  get scrollback(): string {
    return this.#kept.join('');
  }

  attach(listener: TerminalListener): () => void {
    this.#flush(); // the scrollback the caller is about to send includes everything so far
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  write(data: string): void {
    if (this.info.exitCode === undefined) this.#pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.info.exitCode === undefined) this.#pty.resize(cols, rows);
  }

  kill(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#listeners.clear();
    if (this.info.exitCode === undefined) {
      try {
        this.#pty.kill();
      } catch {
        // already gone
      }
    }
  }

  #flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pending === '') return;
    const data = this.#pending;
    this.#pending = '';
    this.#kept.push(data);
    this.#keptChars += data.length;
    while (this.#keptChars > SCROLLBACK_CHARS && this.#kept.length > 1) {
      this.#keptChars -= this.#kept.shift()!.length;
    }
    if (this.#keptChars > SCROLLBACK_CHARS) {
      // One chunk bigger than the whole budget: keep its tail.
      this.#kept[0] = this.#kept[0]!.slice(-SCROLLBACK_CHARS);
      this.#keptChars = this.#kept[0].length;
    }
    for (const l of this.#listeners) l({ data });
  }
}

export class TerminalManager {
  readonly #spawn: Promise<SpawnPty | null>;
  readonly #onChange: (workspaceId: string) => void;
  readonly #env: NodeJS.ProcessEnv;
  readonly #terminals = new Map<string, Terminal>();

  /** `onChange`: a workspace's list of terminals changed (one opened, exited or closed). */
  constructor(opts: {
    spawn: Promise<SpawnPty | null> | SpawnPty | null;
    onChange: (workspaceId: string) => void;
    env?: NodeJS.ProcessEnv;
  }) {
    this.#spawn = Promise.resolve(opts.spawn);
    this.#onChange = opts.onChange;
    this.#env = opts.env ?? process.env;
  }

  async available(): Promise<boolean> {
    return (await this.#spawn) !== null;
  }

  list(workspaceId: string): TerminalInfo[] {
    return [...this.#terminals.values()].filter((t) => t.info.workspaceId === workspaceId).map((t) => ({ ...t.info }));
  }

  async create(workspaceId: string, cwd: string, cols: number, rows: number): Promise<TerminalInfo> {
    const spawn = await this.#spawn;
    if (!spawn) throw new InvalidRequestError('terminals are not available here (node-pty could not be loaded)');
    const { shell, args } = userShell(this.#env);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'hc-web' });
    const pty = spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env });
    const info: TerminalInfo = {
      id: `term-${randomBytes(6).toString('hex')}`,
      workspaceId,
      title: basename(shell),
      cwd,
      createdAt: Date.now(),
    };
    const terminal = new Terminal(info, pty, () => this.#onChange(workspaceId));
    this.#terminals.set(info.id, terminal);
    this.#onChange(workspaceId);
    return { ...info };
  }

  /** Start sending `id`'s output to `listener`; resolves with what came before. */
  attach(id: string, listener: TerminalListener): { scrollback: string; exitCode?: number; detach: () => void } {
    const t = this.#get(id);
    const detach = t.attach(listener);
    return { scrollback: t.scrollback, ...(t.info.exitCode !== undefined ? { exitCode: t.info.exitCode } : {}), detach };
  }

  input(id: string, data: string): void {
    this.#get(id).write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.#get(id).resize(cols, rows);
  }

  close(id: string): void {
    const t = this.#get(id);
    t.kill();
    this.#terminals.delete(id);
    this.#onChange(t.info.workspaceId);
  }

  /** Close every terminal of a workspace (it stops being hosted). */
  closeWorkspace(workspaceId: string): void {
    for (const t of [...this.#terminals.values()]) if (t.info.workspaceId === workspaceId) this.close(t.info.id);
  }

  shutdown(): void {
    for (const t of this.#terminals.values()) t.kill();
    this.#terminals.clear();
  }

  #get(id: string): Terminal {
    const t = this.#terminals.get(id);
    if (!t) throw new TerminalNotFoundError(id);
    return t;
  }
}
