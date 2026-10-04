import { spawn, type ChildProcess } from 'node:child_process';
import { relative, resolve } from 'node:path';

import { z } from 'zod';

import { truncateHeadTail } from '../context/truncate.js';
import { wrapCommand } from '../permissions/macos-sandbox.js';
import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import { guardSecretSearch, sandboxedEnv } from '../permissions/sandbox.js';
import { signalGroup, type BackgroundProcesses } from './background.js';
import type { ToolContext, ToolResult, ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  command: z.string().describe('Shell command to run.'),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Kill the command after this many milliseconds (default 120000).'),
  cwd: z.string().optional().describe('Directory to run in, relative to the workspace root.'),
});

const backgroundSchema = schema.extend({
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Start it and return at once, for a server, watcher or long build: read its output with bash_output, stop it with bash_kill.',
    ),
});

type Input = z.infer<typeof backgroundSchema>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
const HEAD_CHARS = 20_000;
const TAIL_CHARS = 8_000;
const KILL_GRACE_MS = 2_000;
const ABORTED = 'Could not run command: The operation was aborted';

/**
 * Commands still running. Each has its own process group, out of reach of a
 * signal to this process's, so this process takes them along when it exits.
 */
const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of running) signalGroup(child, 'SIGKILL');
});

/**
 * No command-line vetting here on purpose — that is the permission engine's
 * job (AST-based review in `bash-ast.ts`, run before this tool is ever
 * called). This tool is spawn + env allowlist + OS sandbox + secret-skipping
 * `grep` / `rg` + timeout + output cap: the layer that runs whatever command
 * was already approved, as confined as this machine allows.
 */
export const bashTool: ToolSpec<Input> = createBashTool();

/**
 * `bash`, and with `background` (`settings.backgroundProcesses`) its
 * `run_in_background` parameter. Without it the tool is exactly as it always
 * was: what the model is shown must not change by default.
 */
export function createBashTool(background?: BackgroundProcesses): ToolSpec<Input> {
  return {
    name: 'bash',
    description: 'Run a shell command in the workspace and return its combined stdout/stderr.',
    schema: background ? backgroundSchema : schema,
    readOnly: false,
    concurrencySafe: false,
    execute: (input, ctx) => runBash(input, ctx, background),
  };
}

async function runBash(input: Input, ctx: ToolContext, background: BackgroundProcesses | undefined): Promise<ToolResult> {
  const requestedCwd = input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
  let cwd: string;
  try {
    cwd = await assertInsideWorkspace(ctx.cwd, requestedCwd);
  } catch (err) {
    const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
    return { content: message, isError: true };
  }
  if (background && input.run_in_background === true) {
    try {
      const started = background.start(input.command, cwd, relative(ctx.cwd, cwd));
      return {
        content: `Started in the background as ${started.id}${started.pid !== undefined ? ` (pid ${started.pid})` : ''}. Read what it prints with bash_output, stop it with bash_kill.`,
      };
    } catch (err) {
      return { content: errorMessage(err), isError: true };
    }
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The writable region is the whole workspace (ctx.cwd), not just the possibly
  // narrower execution directory — a command run from a subdirectory can still
  // legitimately write to a sibling path within the same workspace.
  const { cmd: spawnCmd, args: spawnArgs } = wrapCommand(['-c', guardSecretSearch(input.command)], ctx.cwd);
  if (ctx.signal?.aborted) return { content: ABORTED, isError: true };

  return new Promise<ToolResult>((resolvePromise) => {
    // Its own process group, so a timeout or an abort stops what the shell
    // started — a pipeline, `cd x && cmd`, something put in the background —
    // and not just the shell, whose children would keep the output pipes open
    // and this promise waiting on them.
    const child = spawn(spawnCmd, spawnArgs, { cwd, env: sandboxedEnv(), detached: true });
    running.add(child);
    let output = '';
    let timedOut = false;
    let settled = false;
    let force: NodeJS.Timeout | undefined;

    const stop = (): void => {
      signalGroup(child, 'SIGTERM');
      force = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        // Whatever left the group (setsid) may still hold the pipes: stop waiting on them.
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, KILL_GRACE_MS).unref();
      }, KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const onAbort = (): void => {
      stop();
      finish({ content: ABORTED, isError: true });
    };

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolvePromise(result);
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    // Decoded per stream, so a character split across two chunks stays whole.
    const onData = (text: string): void => {
      output += text;
      ctx.onOutput?.(text);
    };
    child.stdout?.setEncoding('utf8').on('data', onData);
    child.stderr?.setEncoding('utf8').on('data', onData);

    child.on('close', (code) => {
      running.delete(child);
      clearTimeout(force);
      const truncated = truncateHeadTail(output, {
        maxChars: MAX_OUTPUT_CHARS,
        headChars: HEAD_CHARS,
        tailChars: TAIL_CHARS,
      }).text;
      if (timedOut) {
        finish({
          content: `${truncated}\n[command timed out after ${timeoutMs}ms]`,
          isError: true,
        });
      } else if (code !== 0) {
        finish({ content: `${truncated}\n[exit code ${code}]`, isError: true });
      } else {
        finish({ content: truncated || '(no output)' });
      }
    });

    child.on('error', (err) => {
      running.delete(child);
      finish({ content: `Could not run command: ${err.message}`, isError: true });
    });
  });
}
