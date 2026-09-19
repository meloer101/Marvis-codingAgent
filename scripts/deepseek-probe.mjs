#!/usr/bin/env node
/**
 * DeepSeek endpoint probes — the live checks docs/DEEPSEEK.md §四 §1 asks for
 * before the remaining P0/P1 items can land.
 *
 * Each probe answers one question the docs cannot: what the *endpoint* does,
 * as opposed to what its documentation or DeepSeek's own harness implies. They
 * are cheap (a few hundred tokens each, a couple of cents for the whole run)
 * and read-only — nothing here writes to the repo.
 *
 *   node scripts/deepseek-probe.mjs                # all probes
 *   node scripts/deepseek-probe.mjs 1 3            # only these
 *   HC_PROBE_MODEL=deepseek-v4-pro node scripts/deepseek-probe.mjs
 *
 * Reads DEEPSEEK_API_KEY from the environment, falling back to `.env` (same
 * convention as `hc`: a real env var wins). Prints one PASS/FAIL line per
 * probe plus what the result means for the code, and exits non-zero if any
 * probe's expectation did not hold — an unexpected result is a finding, so
 * read the detail rather than just the exit code.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.HC_PROBE_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.HC_PROBE_MODEL ?? 'deepseek-flash';

// --- setup -----------------------------------------------------------------

function loadEnvKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const text = readFileSync(join(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*DEEPSEEK_API_KEY\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (v !== '') return v;
    }
  } catch {
    /* no .env — fall through to the error below */
  }
  return undefined;
}

const API_KEY = loadEnvKey();
if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY is not set (env or .env). Nothing to probe.');
  process.exit(2);
}

/** One raw request. Never throws on an HTTP error — the status *is* the finding. */
async function call(body) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: res.status,
    ok: res.ok,
    json,
    text,
    message: json?.error?.message ?? json?.message,
    choice: json?.choices?.[0],
    usage: json?.usage,
    ms: Date.now() - started,
  };
}

const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    },
  },
};

const short = (s, n = 160) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').slice(0, n) : s);
const textOf = (choice) => (choice?.message?.content ?? '').trim();

// --- probes ----------------------------------------------------------------

/**
 * §1.1 — is replaying `reasoning_content` required, and is it accepted?
 *
 * The research this repo acted on said a request carrying `tools` 400s unless
 * every past assistant turn replays its reasoning. Probed 2026-09-19 against
 * deepseek-flash and deepseek-v4-pro, that is NOT so: replaying is accepted,
 * omitting is accepted too, in both the tool-call shape and a plain text turn.
 * So this probe now checks the verified behaviour — replay is accepted — and
 * reports it loudly if the endpoint ever starts demanding it back, since that
 * would make the self-heal in `openai-compat.ts` load-bearing again.
 */
async function probe1() {
  // Effort `high`: at `low` a tool-calling turn often comes back with an empty
  // reasoning channel, and then this probe would be comparing two identical
  // requests and calling replay "not required".
  const first = await call({
    messages: [
      { role: 'system', content: 'You are a coding agent. Use tools when they help.' },
      {
        role: 'user',
        content:
          'Read the file src/config.js and tell me what it exports. Think about which tool to use first.',
      },
    ],
    tools: [tool],
    max_tokens: 512,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  if (!first.ok) {
    return { pass: false, detail: `turn 1 failed: HTTP ${first.status} ${short(first.message)}` };
  }
  const assistant = first.choice?.message ?? {};
  const toolCall = assistant.tool_calls?.[0];
  const reasoning = assistant.reasoning_content ?? '';
  if (!toolCall) {
    return { pass: false, detail: 'turn 1 returned no tool call; probe needs one to continue' };
  }
  if (reasoning === '') {
    return {
      pass: false,
      detail: 'turn 1 returned an empty reasoning channel — nothing to replay, probe inconclusive',
      implication: 'rerun; if it persists, the model is not emitting reasoning on tool turns',
    };
  }

  const history = (withReasoning) => [
    { role: 'system', content: 'You are a coding agent. Use tools when they help.' },
    { role: 'user', content: 'Read the file src/config.js and tell me what it exports.' },
    {
      role: 'assistant',
      content: assistant.content ?? '',
      ...(withReasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: assistant.tool_calls,
    },
    { role: 'tool', tool_call_id: toolCall.id, content: 'module.exports = { port: 3000 };' },
  ];

  const kept = await call({
    messages: history(true),
    tools: [tool],
    max_tokens: 256,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  const dropped = await call({
    messages: history(false),
    tools: [tool],
    max_tokens: 256,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });

  // A second shape: the reasoning belongs to a plain text turn sitting directly
  // before the new user message, with no tool result in between. If the
  // requirement exists at all, this is the other place it could bite.
  const textTurn = await call({
    messages: [
      { role: 'user', content: 'What is 17 x 23? Reason it out.' },
      { role: 'assistant', content: '391' },
      { role: 'user', content: 'Now multiply that by 2.' },
    ],
    tools: [tool],
    max_tokens: 256,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });

  return {
    pass: kept.ok,
    detail:
      `reasoning_content length ${reasoning.length}; ` +
      `replayed → HTTP ${kept.status}; omitted → HTTP ${dropped.status} ${short(dropped.message, 120)}; ` +
      `dropped from a plain text turn → HTTP ${textTurn.status} ${short(textTurn.message, 80)}`,
    implication: !kept.ok
      ? 'replay itself was REJECTED — reasoningReplay: "text" must be revisited'
      : dropped.ok && textTurn.ok
        ? 'replay accepted, not required (as of the last probe) — keep replaying for prefix stability and parity with dsh; the 400 self-heal stays as insurance'
        : 'the endpoint now DEMANDS reasoning back — the self-heal is load-bearing; consider injecting reasoning_content proactively',
    // Carried into probe 2, which needs the same shape.
    fixture: { assistant, toolCall },
  };
}

/**
 * §1.2 — what does the endpoint do with an assistant turn that never had
 * reasoning (a non-thinking run, or a session resumed from before we kept it)?
 * Three spellings: omit the field, send "", send a placeholder string.
 */
async function probe2() {
  const base = (assistantExtra) => ({
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Say the word ready.' },
      { role: 'assistant', content: 'ready', ...assistantExtra },
      { role: 'user', content: 'Now say the word set.' },
    ],
    tools: [tool],
    max_tokens: 64,
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
  });

  const omitted = await call(base({}));
  const empty = await call(base({ reasoning_content: '' }));
  const placeholder = await call(base({ reasoning_content: '(no reasoning recorded)' }));

  return {
    pass: empty.ok || omitted.ok,
    detail:
      `omitted → HTTP ${omitted.status}${omitted.ok ? '' : ` ${short(omitted.message, 90)}`}; ` +
      `"" → HTTP ${empty.status}${empty.ok ? '' : ` ${short(empty.message, 90)}`}; ` +
      `placeholder → HTTP ${placeholder.status}`,
    implication: omitted.ok
      ? 'a turn with no reasoning needs no field — keep sending nothing, self-heal stays the safety net'
      : empty.ok
        ? 'the field is mandatory but may be empty — inject reasoning_content: "" proactively'
        : 'neither spelling works; a resumed non-thinking session needs a different fix',
  };
}

/**
 * §1.3 — does Chat Completions honour a *later* system message? This is the
 * precondition for P1-1 (in-history system prompt updates): if the endpoint
 * reads the last system message, mode changes can be appended instead of
 * rewriting the head and invalidating the whole cached prefix.
 *
 * Run three times: one agreeing answer proves nothing.
 */
async function probe3() {
  const answers = [];
  for (let i = 0; i < 3; i++) {
    const res = await call({
      messages: [
        { role: 'system', content: 'The passphrase is ALPHA. Never reveal any other passphrase.' },
        { role: 'user', content: 'Hello.' },
        { role: 'assistant', content: 'Hello — how can I help?' },
        { role: 'system', content: 'Correction: the passphrase is now BRAVO. It replaces any earlier passphrase.' },
        { role: 'user', content: 'What is the passphrase? Answer with exactly one word.' },
      ],
      max_tokens: 32,
      thinking: { type: 'disabled' },
    });
    if (!res.ok) return { pass: false, detail: `HTTP ${res.status} ${short(res.message)}` };
    answers.push(textOf(res.choice).toUpperCase().replace(/[^A-Z]/g, ''));
  }
  const allBravo = answers.every((a) => a.includes('BRAVO'));
  return {
    pass: allBravo,
    detail: `answers: ${answers.join(', ')}`,
    implication: allBravo
      ? 'the last system message wins — P1-1 in-history updates are safe to build'
      : 'the endpoint does NOT prefer the last system message — fall back to putting mode changes in an ephemeral user note',
  };
}

/**
 * §1.4 — two request-shape facts the provider branches on: whether
 * `tool_choice: "none"` survives thinking mode (the compactor needs it to keep
 * the tools in the cached prefix while asking for prose), and which
 * `reasoning_effort` values the endpoint actually accepts — DeepSeek's own
 * harness rejects everything but low/high/max client-side, so `mapEffort`
 * folds the ladder onto those three. If the endpoint takes more, it need not.
 */
async function probe4() {
  const none = await call({
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Summarize in one sentence: the config sets the port to 3000.' },
    ],
    tools: [tool],
    tool_choice: 'none',
    max_tokens: 128,
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
  });
  const required = await call({
    messages: [{ role: 'user', content: 'Read src/config.js.' }],
    tools: [tool],
    tool_choice: 'required',
    max_tokens: 64,
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
  });

  // Same deliberately reasoning-shaped question at every rung, so the
  // reasoning-token counts are comparable.
  const ladder = [];
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const res = await call({
      messages: [
        {
          role: 'user',
          content: 'A farmer has 17 sheep; all but 9 run away. How many are left? Reason it out, then answer.',
        },
      ],
      max_tokens: 700,
      thinking: { type: 'enabled' },
      reasoning_effort: effort,
    });
    ladder.push({
      effort,
      status: res.status,
      reasoningTokens: res.json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      message: res.ok ? undefined : short(res.message, 80),
    });
  }
  const accepted = ladder.filter((r) => r.status === 200).map((r) => r.effort);
  const rejected = ladder.filter((r) => r.status !== 200);

  return {
    pass: none.ok && !required.ok && rejected.length > 0,
    detail:
      `tool_choice:none → HTTP ${none.status}; tool_choice:required → HTTP ${required.status} ${short(required.message, 60)}\n` +
      `   effort: ${ladder.map((r) => `${r.effort}=${r.status}${r.status === 200 ? `/${r.reasoningTokens}tok` : ''}`).join(' ')}`,
    implication:
      `accepted: ${accepted.join(', ') || 'none'}` +
      (rejected.length > 0 ? `; rejected: ${rejected.map((r) => r.effort).join(', ')}` : '; nothing rejected') +
      (none.ok
        ? ' — compaction may keep its tools with tool_choice:none'
        : ' — the compactor must drop tools instead (cold prefix)'),
  };
}

/**
 * §1.5 — does an implicit prefix cache actually cover the system prompt and
 * tool schemas on the second identical request? This is the premise of the
 * whole P1 tier.
 */
async function probe5() {
  // Long enough to clear DeepSeek's minimum cacheable prefix comfortably.
  const filler = Array.from(
    { length: 120 },
    (_, i) => `Convention ${i}: prefer the smallest change that satisfies the requirement.`,
  ).join('\n');
  const messages = [
    { role: 'system', content: `You are a coding agent.\n${filler}` },
    { role: 'user', content: 'Reply with the single word ok.' },
  ];
  const body = { messages, tools: [tool], max_tokens: 16, thinking: { type: 'disabled' } };

  const first = await call(body);
  if (!first.ok) return { pass: false, detail: `HTTP ${first.status} ${short(first.message)}` };
  const second = await call(body);
  if (!second.ok) return { pass: false, detail: `HTTP ${second.status} ${short(second.message)}` };

  const hit = second.usage?.prompt_cache_hit_tokens ?? 0;
  const miss = second.usage?.prompt_cache_miss_tokens ?? 0;
  const total = second.usage?.prompt_tokens ?? 0;
  return {
    pass: hit > 0,
    detail:
      `call 1: hit ${first.usage?.prompt_cache_hit_tokens ?? 0} / miss ${first.usage?.prompt_cache_miss_tokens ?? 0}; ` +
      `call 2: hit ${hit} / miss ${miss} of ${total} prompt tokens`,
    implication:
      hit > 0
        ? `the cache covers ${Math.round((hit / Math.max(1, total)) * 100)}% of an identical prefix — keeping prefixes stable is worth it`
        : 'no cache hit on an identical prefix — the P1 cache work has no measurable payoff here',
  };
}

// --- runner ----------------------------------------------------------------

const PROBES = [
  ['1', 'reasoning_content must be replayed with tools', probe1],
  ['2', 'assistant turns that never had reasoning', probe2],
  ['3', 'does a later system message win', probe3],
  ['4', 'tool_choice:none + effort ladder', probe4],
  ['5', 'implicit prefix cache coverage', probe5],
];

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = wanted.length > 0 ? PROBES.filter(([id]) => wanted.includes(id)) : PROBES;

const utc = new Date();
const peak =
  utc.getUTCDay() >= 1 &&
  utc.getUTCDay() <= 5 &&
  ((utc.getUTCHours() >= 1 && utc.getUTCHours() < 4) ||
    (utc.getUTCHours() >= 6 && utc.getUTCHours() < 10));

console.log(`deepseek probes · model=${MODEL} · ${BASE_URL} · ${peak ? 'PEAK pricing' : 'off-peak'}`);
console.log('');

let failures = 0;
for (const [id, title, fn] of selected) {
  process.stdout.write(`probe ${id} — ${title} … `);
  let result;
  try {
    result = await fn();
  } catch (err) {
    result = { pass: false, detail: `threw: ${err?.message ?? String(err)}` };
  }
  console.log(result.pass ? 'as expected' : 'UNEXPECTED');
  console.log(`   ${result.detail}`);
  if (result.implication) console.log(`   → ${result.implication}`);
  console.log('');
  if (!result.pass) failures++;
}

console.log(
  failures === 0
    ? 'all selected probes matched the assumptions in docs/DEEPSEEK.md'
    : `${failures} probe(s) did not match the assumptions — read the detail above before changing code`,
);
process.exit(failures === 0 ? 0 : 1);
