# Architecture

How `harness-code` (`hc`) is put together, and why. This is the narrative
companion to the feature-by-feature [README](../README.md): it traces one turn
end to end, names the module that owns each job, and explains the four *harness*
concerns the project is really about — context engineering, permissions &
sandboxing, sub-agents, and observability & evaluation.

The thesis: wrapping an LLM in a `while` loop is an afternoon's work; everything
that makes that loop *useful and safe* on a real codebase lives in the layers
around it. This repo is those layers, written to be read.

---

## Package topology

A pnpm workspace. Dependencies point inward — `core` knows nothing about any
frontend; the frontends and the server depend on `core`; `protocol` is a
leaf of pure types shared by the web boundary.

```
                 ┌───────────────────────────────────────────────┐
   frontends     │  cli (one-shot + REPL)      tui (Ink)          │
                 │  server ── ws ── web (React)                   │
                 └───────────────────────┬───────────────────────┘
                                         │ drive
                         ┌───────────────▼───────────────┐
   the engine            │          @harness-code/core    │
                         │  AgentSession · AgentLoop      │
                         │  provider · tools · context ·  │
                         │  memory · permissions · mcp ·  │
                         │  skills · subagents · telemetry│
                         └───────────────┬───────────────┘
                                         │ types only
                              ┌──────────▼──────────┐
   shared boundary           │  @harness-code/protocol  (no node deps) │
                             └─────────────────────────────────────────┘
```

| Package | Role |
| --- | --- |
| `packages/core` | The whole engine — everything below. The only package with the agent logic. |
| `packages/cli` | `hc` binary: one-shot (`hc "…"`, scriptable) and a readline REPL. |
| `packages/tui` | Interactive terminal UI (Ink) — streaming markdown, tool cards, modals, slash commands. |
| `packages/server` | Session host: `node:http` + a single `/ws` WebSocket carrying RPC and the event stream, origin/token auth, static serving. What `hc web` runs. |
| `packages/web` | Browser UI (React 19 · Vite · Tailwind 4 · shadcn · zustand) over the server. Transport, session lifecycle and security: [web.md](./web.md). |
| `packages/protocol` | Frame / event / method types + zod schemas + the shared event-fold logic. No node deps, so both server and browser import it. |
| `evals` | Benchmark tasks, fixtures, cassettes, the runner, and the ablation harness. |

All four frontends are thin: they translate user input into calls on one
`AgentSession` and render the `AgentEvent` stream it emits. The loop has no idea
which one is driving it.

---

## The normalized core: provider layer

`packages/core/src/provider/` exists so the rest of the system speaks exactly one
message shape — `Message { role, content: ContentBlock[] }` where a block is
`text | tool_use | tool_result | thinking`, plus a normalized `Usage` and a
`StreamEvent` union. Providers translate to and from that; nothing above the
provider layer ever sees an endpoint's raw wire format.

- **`openai-compat.ts`** — one adapter over OpenAI Chat Completions, the de-facto
  lingua franca (DeepSeek, Kimi, Qwen, Zhipu, OpenRouter, Groq, Together, Mistral,
  xAI, LiteLLM proxies, Ollama, vLLM, llama.cpp). It is mostly a catalogue of the
  ways "OpenAI-compatible" endpoints disagree: streamed `tool_calls` delta
  reassembly, `finish_reason` that lies while tool calls sit in the payload,
  `reasoning_content` vs `reasoning`, three different cached-token field names,
  endpoints that report no usage at all.
- **`router.ts`** — LiteLLM-style `provider/model` parsing and per-provider
  base-URL / key resolution. Adding an endpoint is normally a data change here.
- **`capabilities.ts`** — per-model capability bits (native tools, parallel tool
  calls, prompt cache, context window, pricing, `allowedToolsChoice`). The loop
  reads these to decide what it may ask the endpoint to do.
- **`prompt-tools.ts`** — the degrade path: when an endpoint has no `tools`
  parameter, tool schemas are rendered into the system prompt and calls are parsed
  back out of the token stream (tolerant of truncation, code fences, Python
  literals), so a tool-less local model runs the identical loop.
- **`dsml-salvage.ts`** — DeepSeek V4 sometimes writes a tool call into the text
  channel as DSML markup its endpoint failed to parse (long context, many tools).
  The markup is held back from the stream and, if it names registered tools and
  no real `tool_calls` came back, turned into tool calls; a trailing bare
  `toolname{json}` is recovered the same way. Counted as `salvagedToolCalls` in
  the trace. On for DeepSeek models behind any provider (`textToolCallSalvage`).
- **`mock.ts`** — a record/replay provider. A live run is captured to a cassette;
  tests and `pnpm eval` replay it deterministically, with symmetric workspace-path
  rewriting so a cassette replays on any machine.

---

## The agent loop and its hooks

`packages/core/src/agent/loop.ts` is a ReAct-shaped state machine:

> assemble request → stream the model → collect `tool_use` → permission gate →
> execute (read-only in parallel, writes serial) → append `tool_result` → repeat

until `end_turn`, a turn/token/cost budget, or an aborted `AbortSignal` (Ctrl+C
propagates all the way into a running `bash` child). **Policy is kept out of the
loop and injected through hooks** rather than `if` branches:

| Hook | Consumers |
| --- | --- |
| `onBeforeTurn` | goal-restatement & budget nudges |
| `onBeforeToolCall` | permission engine, plan mode, skill `allowed-tools` gate |
| `onAfterToolCall` | telemetry, read-before-write ledger |
| `onContextPressure` / `onCompact` | compaction, tool-output pruning/offload |

Because every cross-cutting concern is a hook consumer, the same loop serves
one-shot, REPL, TUI, and web unchanged, and a sub-agent is just another
`AgentLoop` with a narrower tool set and a fresh state.

`AgentSession` (`agent/session*.ts`, `control.ts`) wraps the loop as the façade
the frontends drive: it owns `SessionState` (including the read-before-write
ledger), session persistence to `.agent/sessions/<id>.jsonl` (for `--resume`),
the activated-skill set, and flushes buffered memory writes at `close()`.

### One turn, end to end

```mermaid
flowchart TD
  U[Frontend: user prompt] --> S[AgentSession]
  S --> A[AgentLoop.run]
  A --> P[Assemble request<br/>stable system prefix + history]
  P --> PR[Provider.stream<br/>openai-compat / router]
  PR --> EP[(LLM endpoint)]
  EP -->|stream: text · thinking · tool_use| A
  A --> G{Permission gate<br/>+ skill allowed-tools}
  G -->|deny| R[tool_result: Denied]
  G -->|allow| X[Execute tools<br/>read-only parallel · writes serial]
  X --> R
  R --> CP{Context pressure?}
  CP -->|>=92%| K[Compact: structured digest<br/>+ never-drop safety invariants<br/>+ offload pruned output]
  CP -->|no| A
  K --> A
  A -->|every step| T[(Telemetry trace<br/>.agent/traces/id.jsonl)]
  A -->|end_turn / budget / abort| D[Result + usage to frontend]
```

---

## Pillar 1 — Context engineering

`packages/core/src/context/` keeps the window productive over a long session.

- **`compactor.ts`** — past a window fraction (default 92%) the oldest turns are
  summarized by a cheap model into a *structured* digest (task state, decisions,
  files touched, open questions, snippets); the first user message is kept
  verbatim, and so are the user's later messages from the compacted span (newest
  first, up to 20k tokens), so a correction the digest glossed over survives.
  A **never-drop safety pass** extracts user prohibitions and
  denied-permission boundaries from history and re-injects any the summarizer
  dropped — compaction cannot silently lose a "don't touch X" or a refused scope.
  The same module prunes bulky `tool_result` bodies and **offloads** them to
  `.agent/sessions/<id>/toolout-*.txt`, leaving a placeholder that points `read`
  at the file (reversible; a write failure falls back to a re-call stub).
- **`tool-output.ts`** — one token cap (default 10k) on every tool result as it
  enters history, keeping the start and the end; the full text goes to the same
  `toolout-*.txt` store the compactor offloads into, and the result names the file.
- **`tokenizer.ts`** — heuristic token counting with an **EMA calibrator** that
  regresses the heuristic against each turn's real `usage`, so budget math tracks
  the endpoint rather than a fixed ratio (CJK weighted apart from ASCII).
- **`cache.ts`** — enforces a fixed system-prefix order (system → skills manifest
  → memory → project instructions → history) so automatic prefix caching keeps
  hitting; hit rate is reported per turn.
- **`budget.ts`** — per-category accounting (system / memory / tools / history),
  surfaced each turn.
- **`memory.ts`** — loads `AGENTS.md` / `CLAUDE.md` from project root down to cwd
  (plus `~/.agent/`) as standing instructions.

The design invariant throughout: **don't move the cached prefix.** Mid-session
skill loading constrains tool *choice* (not the schema array), goal nudges are
*ephemeral*, and memory writes are buffered to `close()` — each a deliberate
choice to preserve KV-cache hits.

### Cross-session memory

`packages/core/src/memory/` is the capability a bare loop lacks: memory that
survives across sessions. Two tiers — `~/.agent/memory/` (global: user profile,
working-style feedback, per-task-type notes) and `<project>/.agent/memory/`
(decisions/outcomes, project feedback, external pointers) — disclosed the same
way skills are: an `<available_memory>` manifest in the prompt, full entries read
on demand via the `memory` tool. `buffer.ts` batches writes and `store.ts` flushes
them once at session close. No semantic retrieval, dedup/merge, or sync — by
choice.

---

## Pillar 2 — Permissions & sandbox

`packages/core/src/permissions/` is a rule engine over `Tool(specifier)` patterns
(`Bash(git status:*)`, `Read(./src/**)`, `mcp__github__create_issue`) with
`allow` / `ask` / `deny` lists (deny always wins), layered user → project, across
six modes: `ask`, `plan`, `acceptEdits`, `readOnly`, `yolo`, `auto`.

- **Bash via AST.** Commands are parsed with `shell-quote` into an AST, not
  regex-matched; compound commands (`&&`, `|`, `;`, newlines) are judged segment
  by segment. Two kinds of refusal: *destructive* (`rm -rf` of `/`, `~`, the
  workspace root or anything outside it; `.ssh`; `chmod 777 /`; piping into a
  shell) holds in every mode, and is also searched for in the raw text of
  commands that don't parse. *Unreviewable* commands (`$(…)`, heredocs, inline
  eval flags for `node`/`python`/`perl`/`ruby`, which would escape a
  `Bash(node:*)` allowance) can't be checked segment by segment, so they go to
  whoever can judge them: the person in `ask`/`acceptEdits`, the classifier in
  `auto`; `yolo` allows them (it reviews nothing, and the same code written to a
  file runs anyway); `plan`/`readOnly` refuse. In every mode the raw text is
  still checked against `Bash` deny rules and for sensitive paths.
- **Path cage.** Paths are `realpath`-resolved and must stay inside the workspace
  (blocks symlink and `../` escape) — or, for the file tools, inside the system
  temp dir, which the OS sandbox already lets shell commands write, so scratch
  files need not land in the workspace; a denylist blocks `.env*`, `.git/config`,
  private keys, credentials. Protected paths (`.git`, editor/config dirs, rc
  files) are asked in `ask`/`acceptEdits`, classified in `auto`, denied in
  `plan`/`readOnly`, and allowed in `yolo`.
- **OS sandbox.** On macOS a `sandbox-exec` profile confines child processes to
  workspace and temp-dir writes — the layer that catches what textual review misses (e.g. a
  legitimate tool doing `echo x > /outside`).
- **"Don't ask again" stays narrow.** Approving a call for the session adds a
  rule for that kind of call only (`alwaysAllowFor`): a command's prefix
  (`Bash(npm test:*)`, `Bash(pnpm run build:*)`, `Bash(python scripts/gen.py:*)`),
  the exact command where a prefix would reach further (`rm`, `curl`, `cd`,
  `time`), a fetch's host — never the whole `Bash` tool. Commands no rule can
  hold (`sh`, `xargs`, `sudo`, loops, unreviewable text) are not offered it.
- **Non-interactive safety.** With no one to answer, an `ask` verdict
  deterministically *denies* rather than hanging — the precondition for scripting.
- **Auto mode.** The engine stays synchronous and may return `{ decision: 'classify' }`.
  A second model (the classifier, `autoMode.model` or the session model) then
  allows, denies with a rule label, or — after 3 consecutive / 20 cumulative
  denials — falls back to a human prompt. Project-level `autoMode` and
  `permissions.mode: "auto"` are stripped on load so a repo cannot self-authorize.
  Shift+Tab cycles `ask → acceptEdits → plan → [yolo] → [auto]`; `/permissions`
  and `hc auto-mode` edit the user-level rule lists.

MCP tools ride this same engine (they can't self-report side effects, so they
default to the `bash` tier: serial, non-read-only, asked).

---

## Pillar 3 — Sub-agents & parallelism

`packages/core/src/subagents/` dispatches isolated work. The `task` tool runs a
named agent (`.agent/agents/*.md`, `~/.agent/agents/`, or builtins `explore` /
`plan`) as its own `AgentLoop` on a **fresh context window**; only its final
message returns to the caller. A grep-heavy investigation that would push tens of
thousands of tokens of match output into the main conversation instead costs it
one paragraph (measured: parent history stayed 4.1k while the sub-agent spent 3.1k
searching).

Invariants: a sub-agent's permissions only *narrow* (parent rules + mode, never a
rule added; tool set filtered to the def's `tools`); `task` is never in a
sub-agent's tools (no recursion); several `task` calls in one turn run
concurrently under the loop's concurrency cap; each is turn-budgeted and its usage
folds into the session total. The sub-agent's system prompt shares the parent's
`identity` + `conventions` byte-for-byte, so it hits the same cached prefix.

---

## Pillar 4 — Observability & evaluation

**Telemetry** (`packages/core/src/telemetry/`) appends a structured trace to
`.agent/traces/<id>.jsonl` — one event per model call (tokens / cache / latency /
cost), tool call (input summary, duration, output bytes, `denied` flag),
compaction, sub-agent rollup, provider error, and run outcome. It is a *separate*
file from the session log: the session log stays messages-only for `--resume`,
the trace carries volatile numbers that `hc trace` / `hc stats` read without
touching it. Tool output bodies never enter the trace (byte count only) — copying
multi-megabyte dumps here is a mistake that has bitten before.

**Evaluation** (`evals/`) runs the *whole* loop — real tools, real permission
engine, real compaction — against fixture tasks (each a self-contained project
with a prompt and an `assert.mjs`). The model is served from a committed cassette,
so CI reruns identically with no network; a task that stops passing, or a >15%
rise in tokens/cost vs `baseline.json`, fails the command. `--record` re-records
against a live endpoint; **`--ablation <compaction|subagents|prompt-tools>`** runs
the suite twice (two live arms whose differing request shape can't replay) and
prints the comparison the README's ablation tables come from.

> Note on the baseline: live `--record` numbers come from the endpoint's real
> `usage`, while replay numbers are heuristic-estimated (the EMA calibrator only
> corrects on live runs). Since CI gates on replay, `baseline.json` is kept
> replay-derived (`--update-baseline`) so the gate is self-consistent.

---

## Runtime layout (`.agent/`)

Everything a run produces or reads lives under `.agent/`, aligned with Claude
Code's shapes so ecosystem MCP servers and skills drop in unchanged:

```
.agent/
  settings.json        model / provider / capability overrides (layered under ~/.agent/)
  .mcp.json            MCP servers (stdio / http / sse), ${ENV} interpolation
  agents/*.md          sub-agent definitions
  skills/**/SKILL.md   project skills (progressive disclosure)
  memory/              project-scoped cross-session memory
  plans/<slug>.md      plan-mode output
  sessions/<id>.jsonl  resumable conversation log (+ <id>/toolout-*.txt offloads)
  traces/<id>.jsonl    telemetry
```

That is the layout inside a project (a directory with `.git` or `.agent` above
it). Run in a directory that is not one, `hc` keeps `sessions/`, `traces/` and
`memory/` under `~/.agent/projects/<name>-<hash>/` instead, so it leaves no
`.agent/` behind; `HC_STATE_DIR` sends `sessions/` and `traces/` anywhere — the
Harbor adapter points it at the trial's log dir, so an agent working in a task
directory never finds (or commits) the harness's own logs there.

Settings layer built-in defaults → `~/.agent/settings.json` →
`.agent/settings.json`. Credentials come only from the environment
(`DEEPSEEK_API_KEY`, `HC_<PROVIDER>_API_KEY`, …), read in one place and redacted
before any error prints.

---

## Where to start reading

- The loop and its hooks: [`packages/core/src/agent/loop.ts`](../packages/core/src/agent/loop.ts)
- Endpoint normalization: [`packages/core/src/provider/openai-compat.ts`](../packages/core/src/provider/openai-compat.ts)
- Compaction + safety invariants: [`packages/core/src/context/compactor.ts`](../packages/core/src/context/compactor.ts)
- The permission engine: [`packages/core/src/permissions/`](../packages/core/src/permissions)
- The eval/ablation harness: [`evals/src/cli.ts`](../evals/src/cli.ts)
