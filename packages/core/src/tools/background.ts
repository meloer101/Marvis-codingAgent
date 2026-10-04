/**
 * Background processes: commands `bash` started with `run_in_background` —
 * a dev server, a watcher, a long build — that outlive the call and the turn.
 * The agent reads what each printed since it last looked (`bash_output`) and
 * stops it (`bash_kill`); a frontend follows them through `onEvent`.
 *
 * Opt-in (`settings.backgroundProcesses`): the extra parameter and the two
 * tools change what the model is shown, and the default tool list must stay
 * as it is (eval cassettes record it).
 *
 * Each runs in its own process group, as the foreground `bash` runs —
 * same sandbox, same environment allowlist — so stopping it stops what it
 * started too. All of a session's go when it closes.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { z } from 'zod';

import { truncateHeadTail } from '../context/truncate.js';
import { wrapCommand } from '../permissions/macos-sandbox.js';
import { guardSecretSearch, sandboxedEnv } from '../permissions/sandbox.js';
import type { AnyToolSpec, ToolSpec } from './types.js';

export interface BackgroundProcessInfo {
  /** `bg1`, `bg2`, … in the order they started. */
  id: string;
  command: string;
  /** Where it runs, relative to the workspace root; `''` for the root. */
  cwd: string;
  pid?: number;
  startedAt: number;
  status: 'running' | 'exited' | 'killed';
  /** Once it ended on its own: its exit code (`null` when a signal ended it). */
  exitCode?: number | null;
  endedAt?: number;
}

export type BackgroundProcessEvent =
  | { type: 'process_start'; process: BackgroundProcessInfo }
  /** What it printed, as it printed it (stdout and stderr together). */
  | { type: 'process_output'; id: string; text: string }
  | { type: 'process_end'; process: BackgroundProcessInfo };

/** At most this many run at once. */
export const MAX_BACKGROUND_PROCESSES = 8;
/** Each keeps the last this-many characters it printed. */
const KEEP_CHARS = 1_000_000;
/** A `bash_output` read returns at most this much: the head and the tail of what's new. */
const READ_MAX_CHARS = 30_000;
const KILL_GRACE_MS = 2_000;

interface Proc {
  info: BackgroundProcessInfo;
  child: ChildProcess;
  /** What it printed, its last `KEEP_CHARS`. */
  text: string;
  /** How many characters were printed before `text` starts. */
  base: number;
  /** Where the agent's last read ended, counted from the first character printed. */
  readTo: number;
  ended: Promise<void>;
  /** `kill` asked it to stop: when it ends, it was killed. */
  killing?: boolean;
}

export interface BackgroundRead {
  process: BackgroundProcessInfo;
  /** Printed since the last read (head and tail when long). */
  output: string;
  /** Characters printed since the last read that were no longer kept. */
  dropped: number;
}

export class BackgroundProcesses {
  readonly #root: string;
  readonly #onEvent: ((event: BackgroundProcessEvent) => void) | undefined;
  readonly #procs = new Map<string, Proc>();
  #seq = 0;

  constructor(opts: { root: string; onEvent?: (event: BackgroundProcessEvent) => void }) {
    this.#root = opts.root;
    this.#onEvent = opts.onEvent;
  }

  /** Every process this session started, oldest first. */
  list(): BackgroundProcessInfo[] {
    return [...this.#procs.values()].map((p) => ({ ...p.info }));
  }

  get running(): number {
    let n = 0;
    for (const p of this.#procs.values()) if (p.info.status === 'running') n++;
    return n;
  }

  /**
   * Start `command` in `cwd` (absolute, inside the workspace — the caller
   * checked); `relCwd` is how it's shown. Throws when too many run already.
   */
  start(command: string, cwd: string, relCwd: string): BackgroundProcessInfo {
    if (this.running >= MAX_BACKGROUND_PROCESSES) {
      throw new Error(`${MAX_BACKGROUND_PROCESSES} background commands are running already; stop one with bash_kill first`);
    }
    const { cmd, args } = wrapCommand(['-c', guardSecretSearch(command)], this.#root);
    // Its own process group, so a kill reaches what it started (a dev server's node, say).
    const child = spawn(cmd, args, { cwd, env: sandboxedEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const id = `bg${++this.#seq}`;
    const info: BackgroundProcessInfo = {
      id,
      command,
      cwd: relCwd,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      startedAt: Date.now(),
      status: 'running',
    };
    let resolveEnded: () => void = () => {};
    const proc: Proc = { info, child, text: '', base: 0, readTo: 0, ended: new Promise((r) => (resolveEnded = r)) };
    this.#procs.set(id, proc);

    const onData = (text: string): void => {
      proc.text += text;
      if (proc.text.length > KEEP_CHARS) {
        const cut = proc.text.length - KEEP_CHARS;
        proc.text = proc.text.slice(cut);
        proc.base += cut;
      }
      this.#onEvent?.({ type: 'process_output', id, text });
    };
    child.stdout?.setEncoding('utf8').on('data', onData);
    child.stderr?.setEncoding('utf8').on('data', onData);
    const end = (exitCode: number | null, error?: string): void => {
      if (proc.info.status !== 'running') return resolveEnded();
      if (error) onData(`\n[could not run: ${error}]\n`);
      proc.info = { ...proc.info, status: proc.killing ? 'killed' : 'exited', ...(proc.killing ? {} : { exitCode }), endedAt: Date.now() };
      this.#onEvent?.({ type: 'process_end', process: { ...proc.info } });
      resolveEnded();
    };
    child.on('close', (code) => end(code));
    child.on('error', (err) => end(null, err.message));
    this.#onEvent?.({ type: 'process_start', process: { ...info } });
    return { ...info };
  }

  /** What process `id` printed since the agent last read it, and how it is. Undefined for an unknown id. */
  read(id: string): BackgroundRead | undefined {
    const proc = this.#procs.get(id);
    if (!proc) return undefined;
    const end = proc.base + proc.text.length;
    const from = Math.max(proc.readTo, proc.base);
    const dropped = from - proc.readTo;
    proc.readTo = end;
    const output = truncateHeadTail(proc.text.slice(from - proc.base), {
      maxChars: READ_MAX_CHARS,
      headChars: 10_000,
      tailChars: 18_000,
    }).text;
    return { process: { ...proc.info }, output, dropped };
  }

  /** Everything process `id` printed that is kept, for a frontend — the agent's reads are left as they are. */
  output(id: string): { process: BackgroundProcessInfo; text: string } | undefined {
    const proc = this.#procs.get(id);
    return proc ? { process: { ...proc.info }, text: proc.text } : undefined;
  }

  /**
   * Stop process `id` and what it started: SIGTERM to its group, SIGKILL if
   * it's still there after a grace period. Resolves once it has ended;
   * undefined for an unknown id.
   */
  async kill(id: string): Promise<BackgroundProcessInfo | undefined> {
    const proc = this.#procs.get(id);
    if (!proc) return undefined;
    if (proc.info.status === 'running') {
      proc.killing = true;
      signalGroup(proc.child, 'SIGTERM');
      const force = setTimeout(() => signalGroup(proc.child, 'SIGKILL'), KILL_GRACE_MS);
      await proc.ended;
      clearTimeout(force);
    }
    return { ...proc.info };
  }

  /** Stop every one still running (the session is closing). */
  async killAll(): Promise<void> {
    await Promise.all([...this.#procs.keys()].map((id) => this.kill(id)));
  }
}

/** Signal `child`'s process group (it was spawned `detached`), or the process alone when there is none. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone already, or never formed: try the process itself.
    try {
      child.kill(signal);
    } catch {
      // Gone.
    }
  }
}

const idSchema = z.object({ id: z.string().describe('The background command\'s id, e.g. bg1.') });

function describe(p: BackgroundProcessInfo): string {
  if (p.status === 'running') return `${p.id} is running`;
  if (p.status === 'killed') return `${p.id} was stopped`;
  return `${p.id} exited${p.exitCode === null ? ' on a signal' : ` with code ${p.exitCode}`}`;
}

function unknown(bg: BackgroundProcesses, id: string): string {
  const ids = bg.list().map((p) => p.id);
  return `No background command ${id}${ids.length > 0 ? ` (there are ${ids.join(', ')})` : ''}.`;
}

/** `bash_output` and `bash_kill`, over this session's background commands. */
export function createBackgroundTools(bg: BackgroundProcesses): AnyToolSpec[] {
  const output: ToolSpec<{ id: string }> = {
    name: 'bash_output',
    description: 'Read what a background command (bash with run_in_background) printed since you last read it, and whether it is still running.',
    schema: idSchema,
    readOnly: true,
    concurrencySafe: true,
    async execute({ id }) {
      const read = bg.read(id);
      if (!read) return { content: unknown(bg, id), isError: true };
      const lost = read.dropped > 0 ? `[${read.dropped} earlier characters were not kept]\n` : '';
      return { content: `${describe(read.process)}.\n${lost}${read.output || '(no new output)'}` };
    },
  };
  const kill: ToolSpec<{ id: string }> = {
    name: 'bash_kill',
    description: 'Stop a background command (bash with run_in_background), and what it started.',
    schema: idSchema,
    readOnly: true,
    concurrencySafe: true,
    async execute({ id }) {
      const before = bg.list().find((p) => p.id === id);
      if (!before) return { content: unknown(bg, id), isError: true };
      if (before.status !== 'running') return { content: `${describe(before)} already.` };
      const after = await bg.kill(id);
      return { content: after ? `${describe(after)}.` : unknown(bg, id) };
    },
  };
  return [output, kill] as AnyToolSpec[];
}
