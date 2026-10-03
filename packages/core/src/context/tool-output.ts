/**
 * One output cap for every tool, applied as a result enters history.
 *
 * Tools still truncate in their own terms (`bash` at 30k chars, `grep` at 200
 * matches), but those limits differ wildly and `read` has none worth the name
 * (2000 lines × 2000 chars). The loop therefore caps every result at a single
 * token budget before it reaches the model — the way codex does in
 * `context_manager/history.rs` — keeping the start and the end, with a header
 * that says how big the original was and where the full text went.
 *
 * `ToolOutputStore` is where the full text goes: `toolout-<n>.txt` files in the
 * session's artifact directory, which the `read` tool can open. The compactor's
 * pruning writes through the same store, so the two never reuse a file name.
 */

import { mkdir, readdir, writeFile as writeFileNative } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { heuristicTokenCount } from './tokenizer.js';
import { truncateHeadTail } from './truncate.js';

export const DEFAULT_TOOL_OUTPUT_MAX_TOKENS = 10_000;

/** Share of the kept budget that goes to the start; the rest keeps the end, where errors land. */
const HEAD_SHARE = 0.6;

const FILE_PATTERN = /^toolout-(\d+)\.txt$/;

export class ToolOutputStore {
  #firstFree: Promise<number> | undefined;
  #taken = 0;

  constructor(
    /** Absolute directory the files are written to. */
    readonly dir: string,
    /** Workspace root; returned paths are relative to it so `read` can open them (absolute outside it). */
    private readonly cwd: string,
    private readonly write: (path: string, data: string) => Promise<void> = writeFileNative,
  ) {}

  /**
   * Write `content` to the next unused `toolout-<n>.txt` and return its
   * workspace-relative path, or `undefined` if it could not be written.
   * Numbering continues after files already in the directory, so a resumed
   * session never overwrites what an earlier placeholder points at.
   */
  async save(content: string): Promise<string | undefined> {
    try {
      this.#firstFree ??= this.#scan();
      const n = (await this.#firstFree) + this.#taken++;
      const abs = join(this.dir, `toolout-${n}.txt`);
      await this.write(abs, content);
      const rel = relative(this.cwd, abs);
      return rel.startsWith('..') || isAbsolute(rel) ? abs : rel.split(sep).join('/');
    } catch {
      return undefined;
    }
  }

  async #scan(): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    let next = 0;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const m = FILE_PATTERN.exec(name);
      if (m) next = Math.max(next, Number(m[1]) + 1);
    }
    return next;
  }
}

export interface ToolOutputCapOptions {
  maxTokens: number;
  /** Where the full text is saved; without one the model is told to narrow the call instead. */
  store?: ToolOutputStore;
}

/**
 * Return `content` unchanged when it fits `maxTokens`; otherwise keep its start
 * and end within the budget under a header naming the original size and the
 * saved copy.
 */
export async function capToolOutput(content: string, opts: ToolOutputCapOptions): Promise<string> {
  const tokens = heuristicTokenCount(content);
  if (tokens <= opts.maxTokens) return content;

  // Convert the token budget to characters at this text's own density, so CJK
  // output (denser per character) is not kept at four times the budget.
  const keepChars = Math.floor((opts.maxTokens * content.length) / tokens);
  const headChars = Math.floor(keepChars * HEAD_SHARE);
  const cut = truncateHeadTail(content, {
    maxChars: 0,
    headChars,
    tailChars: keepChars - headChars,
  });

  const lines = content.split('\n').length;
  const saved = await opts.store?.save(content);
  const next = saved
    ? `Full output saved to ${saved} — read it with offset/limit, or grep it, for the part you need.`
    : 'Re-run the tool with a narrower query for the part you need.';
  return (
    `[Output truncated: ~${tokens} tokens, ${lines} lines; showing the start and the end. ${next}]\n\n` +
    cut.text
  );
}
