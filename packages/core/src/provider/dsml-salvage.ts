/**
 * Recovering tool calls DeepSeek wrote as text.
 *
 * DeepSeek V4 / V4.1 encode tool calls internally as DSML markup, and the
 * serving stack is supposed to turn that into `tool_calls`. At long context
 * (~95K+) or with many tools (~40) the model intermittently emits the markup in
 * a form the endpoint's parser misses — typically without the opening
 * `<｜DSML｜tool_calls>` wrapper — so it arrives as plain `content` with
 * `finish_reason: "stop"` and no `tool_calls` (vllm-project/vllm#48931). Taken
 * at face value the harness shows the markup and ends the turn. Two grammars:
 *
 *   V4    <｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke>
 *   V4.1  <｜DSML｜ invoke name="bash"><｜DSML｜ parameter name="command" string="true">ls</｜DSML｜ parameter></｜DSML｜ invoke>
 *
 * `string="true"` values are literal text, never trimmed or coerced;
 * `string="false"` values are JSON, and stay a raw string if they don't parse
 * (smg-project/smg#2525). A rarer failure drops the markup entirely and ends
 * the message with `toolname{…json…}`.
 *
 * `DsmlSalvager` sits on the text stream like `PromptToolParser`: text before
 * any markup streams through untouched, and from the first DSML tag on it is
 * held back. Whether the held text was a tool call is only decided at the end,
 * once it is known whether the endpoint returned real `tool_calls` — so a reply
 * that merely *talks about* DSML still reaches the user, just late.
 */

import { parseLooseJSON } from '../util/json.js';
import { partialTagSuffixLength } from './prompt-tools.js';
import type { ToolUseBlock } from './types.js';

/** `<｜DSML｜` or `</｜DSML｜`, ASCII bars tolerated. */
const TAG_START = /<\/?[｜|]DSML[｜|]/;
const TAG_PREFIXES = ['<｜DSML｜', '</｜DSML｜', '<|DSML|', '</|DSML|'];

const BAR = '[｜|]';
const INVOKE = new RegExp(
  `<${BAR}DSML${BAR}\\s*invoke\\s+name\\s*=\\s*"([^"]*)"\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}\\s*invoke\\s*>`,
  'g',
);
const OPEN_INVOKE = new RegExp(`<${BAR}DSML${BAR}\\s*invoke\\s+name\\s*=\\s*"([^"]*)"\\s*>`, 'g');
const PARAMETER = new RegExp(
  `<${BAR}DSML${BAR}\\s*parameter\\s+name\\s*=\\s*"([^"]*)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>` +
    `([\\s\\S]*?)</${BAR}DSML${BAR}\\s*parameter\\s*>`,
  'g',
);
/** The wrapper around a batch of invokes: V3.2 `function_calls`, V4 `tool_calls`, V4.1 `calls`. */
const WRAPPER = new RegExp(`</?${BAR}DSML${BAR}\\s*(?:tool_calls|function_calls|calls)\\s*>`, 'g');

export interface SalvageResult {
  /** Text to show and keep in history: the held text, minus whatever became calls. */
  text: string;
  calls: ToolUseBlock[];
}

export class DsmlSalvager {
  #held = '';
  #holding = false;
  #pending = '';
  #seq = 0;

  constructor(
    /** Only invokes naming one of these are salvaged. */
    private readonly toolNames: ReadonlySet<string>,
    private readonly idPrefix = 'salvaged',
  ) {}

  /** Feed a content delta; returns the text safe to show now. */
  push(delta: string): string {
    if (this.#holding) {
      this.#held += delta;
      return '';
    }
    const buffer = this.#pending + delta;
    const m = TAG_START.exec(buffer);
    if (m) {
      this.#holding = true;
      this.#held = buffer.slice(m.index);
      this.#pending = '';
      return buffer.slice(0, m.index);
    }
    const hold = Math.max(...TAG_PREFIXES.map((p) => partialTagSuffixLength(buffer, p)));
    this.#pending = buffer.slice(buffer.length - hold);
    return buffer.slice(0, buffer.length - hold);
  }

  /**
   * The stream ended. `nativeCalls` says whether the endpoint returned real
   * tool calls, in which case nothing is salvaged — the markup was prose.
   */
  end(nativeCalls: boolean): SalvageResult {
    const held = this.#pending + this.#held;
    this.#pending = '';
    this.#held = '';
    if (!this.#holding || nativeCalls) return { text: held, calls: [] };
    return this.#salvage(held);
  }

  #salvage(held: string): SalvageResult {
    const calls: ToolUseBlock[] = [];
    let rest = '';
    let last = 0;
    for (const m of held.matchAll(INVOKE)) {
      calls.push(this.#call(m[1]!, parseParameters(m[2]!)));
      rest += held.slice(last, m.index);
      last = m.index + m[0].length;
    }
    let tail = held.slice(last);

    // An invoke the stream cut off (max_tokens, dropped connection): surface it
    // as a call carrying a parse error, so the model hears what went wrong.
    const open = [...tail.matchAll(OPEN_INVOKE)].at(-1);
    if (open) {
      const block = this.#call(open[1]!, parseParameters(tail.slice(open.index + open[0].length)));
      block.parseError = 'the tool call was cut off before it closed';
      calls.push(block);
      tail = tail.slice(0, open.index);
    }
    rest += tail;

    // Markup that names no registered tool is not a call we should make.
    if (calls.length === 0 || calls.some((c) => !this.toolNames.has(c.name))) {
      return { text: held, calls: [] };
    }
    return { text: rest.replace(WRAPPER, '').trim(), calls };
  }

  #call(name: string, input: Record<string, unknown>): ToolUseBlock {
    return {
      type: 'tool_use',
      id: `${this.idPrefix}_${++this.#seq}`,
      name,
      input,
      rawInput: JSON.stringify(input),
    };
  }
}

function parseParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const m of body.matchAll(PARAMETER)) {
    const [, name, isString, raw] = m as unknown as [string, string, string | undefined, string];
    if (isString === 'true') {
      input[name] = raw;
      continue;
    }
    const parsed = parseLooseJSON(raw.trim());
    input[name] = parsed.ok ? parsed.value : raw;
  }
  return input;
}

/**
 * The markup-free failure: a message whose text ends in `toolname{…}`, where
 * `toolname` is a registered tool and the braces hold a strict JSON object.
 * Anything looser is left alone — this runs on ordinary prose.
 */
export function salvageBareToolCall(
  text: string,
  toolNames: ReadonlySet<string>,
  id = 'salvaged_bare',
): SalvageResult | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('}')) return undefined;
  for (const name of toolNames) {
    const at = trimmed.lastIndexOf(`${name}{`);
    const spaced = at === -1 ? spacedIndex(trimmed, name) : at;
    if (spaced === -1) continue;
    const before = trimmed[spaced - 1];
    if (before !== undefined && !/[\s`>:]/.test(before)) continue;
    const json = trimmed.slice(trimmed.indexOf('{', spaced + name.length));
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    return {
      text: trimmed.slice(0, spaced).trimEnd(),
      calls: [{ type: 'tool_use', id, name, input: value, rawInput: json }],
    };
  }
  return undefined;
}

/** `name {` with whitespace before the brace. */
function spacedIndex(text: string, name: string): number {
  const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\{`, 'g');
  let found = -1;
  for (const m of text.matchAll(re)) found = m.index;
  return found;
}
