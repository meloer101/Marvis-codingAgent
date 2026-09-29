#!/usr/bin/env node
// Stand-in for `hc agent ... --output-format json`, used only by
// `run-eval.mjs --selftest oracle|null` to check the runner and graders end to
// end without a model. It writes the same files hc does (session log, trace,
// one JSON result line on stdout).
//
//   HC_STUB_MODE=oracle  lay evals/tasks/<id>/reference/ over the workspace
//   HC_STUB_MODE=null    change nothing
//
// The task is found by matching the prompt against every task.json.
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const prompt = argv[1];
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const cwd = resolve(opt('--cwd') ?? process.cwd());
const model = opt('--model') ?? 'stub/stub';
const mode = process.env.HC_STUB_MODE ?? 'null';

const tasksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tasks');
const taskId = readdirSync(tasksDir).find((id) => {
  try { return JSON.parse(readFileSync(join(tasksDir, id, 'task.json'), 'utf8')).prompt === prompt; } catch { return false; }
});
if (mode === 'oracle' && taskId && existsSync(join(tasksDir, taskId, 'reference'))) {
  cpSync(join(tasksDir, taskId, 'reference'), cwd, { recursive: true });
}

const sessionId = randomUUID();
const state = process.env.HC_STATE_DIR;
const ts = Date.now();
const final = mode === 'oracle' ? 'Applied the reference solution.' : 'Done.';
mkdirSync(join(state, 'sessions'), { recursive: true });
mkdirSync(join(state, 'traces'), { recursive: true });
writeFileSync(join(state, 'sessions', `${sessionId}.jsonl`), [
  { type: 'message', ts, message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
  { type: 'message', ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }] } },
  { type: 'message', ts, message: { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'src test' }] } },
  { type: 'message', ts, message: { role: 'assistant', content: [{ type: 'text', text: final }] } },
].map((e) => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(join(state, 'traces', `${sessionId}.jsonl`), [
  { type: 'run_start', ts, sessionId, model, cwd },
  { type: 'model_call', ts, turn: 1, model, stopReason: 'tool_use', inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUSD: 0 },
  { type: 'tool_call', ts, turn: 1, id: 't1', name: 'bash', inputSummary: '{"command":"ls"}', durationMs: 1, isError: false, outputBytes: 8 },
  { type: 'run_end', ts, stopReason: 'end_turn', turns: 2, wallMs: 1, inputTokens: 200, outputTokens: 20, cachedInputTokens: 0 },
].map((e) => JSON.stringify(e)).join('\n') + '\n');
process.stdout.write(JSON.stringify({
  type: 'result', session_id: sessionId, stop_reason: 'end_turn', turns: 2, result: final, is_error: false,
  usage: { input_tokens: 200, output_tokens: 20, cached_input_tokens: 0, cost_usd: 0 },
}) + '\n');
