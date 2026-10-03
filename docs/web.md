# marvis web

`marvis web` is the browser frontend: a local server (`packages/server`) that hosts
agent sessions for any number of projects, and a single-page app
(`packages/web`) that talks to it over one WebSocket per tab. `packages/protocol` holds everything both sides share: frame
and event types, the RPC method table (with zod schemas), and the event fold.
Planned work lives in [ROADMAP.md](./ROADMAP.md); the visual system in
[DESIGN.md](../DESIGN.md).

## Running it

```bash
marvis web                 # serve the current directory; opens the browser
marvis web --cwd ~/proj    # another workspace
marvis web --mock          # scripted demo session, no API calls
marvis web --rotate-token  # replace the saved access token
```

- **Port 4317** by default, bound to `127.0.0.1` only. If it is taken by
  something else, any free port is used. An explicit `--port` must be free.
- **One server for every project.** The server on the default port records
  itself in `~/.agent/web/server.json`; running `marvis web` again finds it (live
  pid, and `GET /__hc/health` answers with the recorded boot id), adds the
  current directory to it as a project (`workspace.add`) and opens a new session
  there (`#token=…&w=<workspace>`) instead of starting a second server. The
  projects are remembered in `~/.agent/web/workspaces.json`.
- **One token per user**, in `~/.agent/web/token`, kept across restarts so
  bookmarks and open tabs keep working. `--mock` servers use a throwaway token
  and never record themselves.

**Development.** Run the server with the Vite dev server in front of it:

```bash
marvis web --no-open --dev-origin http://localhost:5173 --port 4317
pnpm --filter @harness-code/web dev
```

The page is served by Vite and proxies `/ws` to the Marvis server (`HC_WEB_PORT`
overrides the target port); `--dev-origin` lets that Origin through the
handshake. Open the `dev:` URL the server prints.

## Workspaces

A workspace is a project directory the server hosts sessions for
(`server/src/hub.ts`). Each has its own cwd, state dir (`.agent/` at its
project root), settings, MCP servers and environment, and its own
`SessionRegistry`; a `WorkspaceHub` routes every session id to the right one
(live hosts, then an index, then the logs on disk).

- **Environment.** Sessions read provider keys and MCP `${VAR}`s from their
  project's environment: the real one, then the project's `.env`, then
  `~/.agent/.env` — the place for keys every project shares — each filling only
  what is still unset (`core/config/dotenv.ts`). Nothing is loaded into the
  server's `process.env`, so one project's `.env` never reaches another's
  sessions. `workspace.list` reports a project whose default model can't run
  as configured (`defaults.keyProblem`, typically a missing key).
- **Adding one** (`workspace.inspect`, then `workspace.add`): a directory, not a
  file; not `/` or the home directory itself. A directory inside a project that
  is already a workspace *is* that workspace. A plain folder under a home that
  has `~/.agent` would share its state dir with every other such folder, so it
  gets its own `.agent/` — only when the request confirms it (`createMarker`).
  With `HC_STATE_DIR` set, every project would share one state dir: only one
  workspace. The directory's MCP servers (what runs, `${VAR}`s left blank) and
  notable project settings (YOLO by default, pre-approved calls, providers
  pointed at another host) come back with the inspection; the UI asks to trust
  them.
- **Picking one.** "Add project" opens the system's folder chooser where the
  server can show one (`fs.pickDir`: `choose folder` through osascript on a
  Mac, zenity or kdialog on a Linux desktop, PowerShell's folder dialog on
  Windows; one at a time). A folder that needs no second look is added at
  once — or, already a workspace, opened; one with MCP servers, settings worth
  reading or a problem opens the add dialog on its path instead. Without a
  chooser (`server.info.capabilities.pickFolder` false — a Linux without a
  desktop session, say), the dialog and its path field, which also has a
  "Choose…" button where there is one.
- **Removing one** stops hosting it (its live sessions close, its files stay):
  not while one of its sessions runs, and never the last one.

## Transport

One socket per tab at `/ws`, carrying RPC and events as JSON frames
(`packages/protocol/src/frames.ts`):

| Frame | Direction | Carries |
|---|---|---|
| `{t:'req', id, method, params}` | client → server | an RPC call |
| `{t:'res', id, ok, result \| error}` | server → client | its answer; `error.code` is `unauthorized`, `not_found`, `busy`, `bad_request`, `conflict` (it would lose work: confirm with `force`) or `internal` |
| `{t:'evt', sessionId, seq, event}` | server → client | one session's event stream, for sessions this socket subscribed to |
| `{t:'push', event}` | server → client | server-wide state, to every authenticated socket |
| `{t:'term', id, data \| exitCode}` | server → client | a terminal's output, or its shell's exit, to the sockets attached to it |

The first frame must be `auth {token}`; anything else, or a wrong token, closes
the socket (code 4001 for a bad token, which the client treats as final). The
client (`lib/rpc.ts`) queues calls made while disconnected, rejects calls in
flight when the socket drops (`disconnected`: it can't know whether they ran),
and reconnects with a 0.5–8 s backoff, skipped when the tab becomes visible or
the network returns.

## Methods

The method table is `packages/protocol/src/methods.ts`; params are validated on
the server with the same schemas the client is typed from.

| Method | What it does |
|---|---|
| `server.info` | version, `bootId`, the launch workspace's defaults, the editors files can be opened in, `capabilities.terminal` (node-pty loaded) and `capabilities.pickFolder` (a folder chooser can be shown) |
| `workspace.list` | every workspace with its defaults (model, mode, modes, effort levels, `keyProblem`) |
| `model.list {workspaceId?}` | the models a session there can be given, each with its windows, effort levels, price and why it can't run, if it can't |
| `workspace.inspect {path}` | what adding a directory would mean — nothing started |
| `workspace.add {path, createMarker?}` / `workspace.remove {id}` | host a project / stop hosting it |
| `fs.suggestDirs {prefix}` | directory completion for the add dialog |
| `fs.pickDir` | show the system's folder chooser on the server's machine; `{path}`, null when it was cancelled |
| `fs.list {workspaceId, sessionId?, dir}` | a workspace folder's entries, folders first — the listing `@` uses, so no ignored files or secrets. With `sessionId`, this and every `fs.*`, `git.*`, `terminal.create` and `editor.open` call acts on the checkout that session works in: its worktree, if it has one |
| `fs.read {workspaceId, sessionId?, path}` | a file's text; binary, over 1 MB, a secret (by name or by what it links to), a link out of the workspace or a missing file: withheld |
| `editor.open {workspaceId, sessionId?, path, line?, editor}` | open a file in VS Code, Cursor or Zed on this machine (`server.info.editors` lists those found) |
| `terminal.list {workspaceId}` / `terminal.create {workspaceId, sessionId?, cols, rows}` | a workspace's terminals / start the user's shell in its root (or the session's worktree) |
| `terminal.attach` / `terminal.detach {id}` | start / stop getting a terminal's output on this socket; attach answers with what it kept (`scrollback`) and its exit code if it ended |
| `terminal.input {id, data}` / `terminal.resize {id, cols, rows}` / `terminal.close {id}` | keystrokes, a new size, and ending it |
| `git.status {workspaceId, sessionId?}` | the workspace's changes against HEAD: branch, upstream, ahead/behind, and per file its staged / unstaged change and lines added / removed |
| `git.diff {workspaceId, sessionId?, path, side?}` | one file's patch against HEAD (an untracked file against nothing), or just its `staged` (HEAD → index) or `unstaged` (index → work tree) changes; binary, too big (> 1 MB) or a secret: withheld |
| `git.applyHunk {workspaceId, sessionId?, path, hunk, action}` | stage, unstage or discard one hunk, its text as `git.diff` showed it: the diff is taken again and a hunk no longer in it is refused; applied with `git apply` at the repository's top — never a secret's |
| `git.stage` / `git.unstage {workspaceId, sessionId?, paths}` | stage files as they are on disk (new files and deletions too) / take them out of the index |
| `git.revert {workspaceId, sessionId?, paths}` | throw changes away: back to HEAD (a rename to its old name), or deleted when HEAD lacks the file — never a secret |
| `git.commit {workspaceId, sessionId?, message, paths?}` | commit what is staged, staging `paths` first when given; hooks run → `{sha, summary}` |
| `git.push {workspaceId, sessionId?}` | push the branch; one without an upstream is published to `origin` (or the only remote) |
| `git.createPr {workspaceId, sessionId?, title, body?, draft?}` | `gh pr create` for the branch — into a worktree's base, when that is a local branch → `{url}` |
| `git.branches {workspaceId}` | the repository's local branches, the checked-out one first, for a worktree to start from (`{repo: false}` outside one) |
| `fs.search {workspaceId, sessionId?, query, limit?}` | a workspace's files matching an `@` query, best first; no ignored files, no secrets |
| `session.list` | every workspace's sessions (on disk plus live), newest first |
| `session.start {text, attachments?, images?, workspaceId?, model?, mode?, effort?, worktree?}` | create a session and send its first message (how a draft becomes a session); a bad attachment or image creates nothing. `worktree {base}`: in a git worktree of its own, on a new branch off `base` |
| `session.create {workspaceId?, model?, mode?, effort?}` | create an empty live session |
| `session.preview {id}` | the live snapshot, or the transcript from disk — never resumes |
| `session.open {id}` | the live snapshot, resuming the session first if needed |
| `session.subscribe {id, sinceSeq?, epoch?}` | start receiving the session's events; replays the gap or answers `{reset, snapshot}` |
| `session.unsubscribe {id}` | stop receiving them |
| `session.send {id, text, attachments?, images?, steer?}` | start a run, or queue the message behind the one going (`{runId}` or `{queued}`); with `steer`, the run reads it at its next step |
| `session.unqueue {id, queuedId}` | take a queued message back before it goes |
| `session.abort {id}` | stop the run; pending prompts settle as a deny, and the queue comes back as `{unqueued}` |
| `session.setMode {id, mode}` | change the permission mode |
| `session.setModel {id, model}` | switch the model, history kept (`busy` mid-run, `bad_request` for a model that can't be resolved) |
| `session.setEffort {id, effort}` | change the reasoning effort, from the next message (`bad_request` for a level the model lacks) |
| `session.update {id, title?, pinned?, archived?, force?}` | rename, pin, archive; answers with the new row. Archiving removes the session's worktree: `conflict` over uncommitted changes there, unless `force` |
| `session.delete {id}` | delete for good: log, metadata, offloaded output, trace, worktree (`busy` while it runs) |
| `session.rewind {id, userMessage}` | take the conversation back to just before that user message (counted from 0 as the transcript shows them); a `rewound` event carries the transcript as it stands; files stay as they are (`busy` while a run goes) |
| `session.fork {id, userMessage?}` | a new session with the conversation, whole or as far as before that message, its model, mode and effort, titled "… · fork"; a worktree session forks into a worktree of its own, branched from the other's branch → `{id}` |
| `session.killProcess {id, processId}` | stop a command the session started in the background, and what it started — answers once it has ended |
| `session.compact {id}` | compact the history now (`busy` while a run is going) |
| `session.trace {id}` | the session's trace (`.agent/traces/<id>.jsonl`): its events and what they add up to — runs, model and tool calls, tokens, cache hits, cost |
| `settings.get {workspaceId}` | the permission rules in `~/.agent/settings.json` and the project's `.agent/settings.json`, the built-in allow rules, the user's auto-mode rules beside the built-in ones and why auto mode is unavailable, if it is; files that don't parse are named, never read for more than their rules (a settings file can hold keys) |
| `settings.setRules {workspaceId, scope, list, rules}` | replace one list (`allow`, `ask`, `deny`) in the user's or the project's settings; every rule must parse, and a file that doesn't is never written over (`bad_request`). The live sessions it applies to — every one for the user's, the project's for its own — take it up at once (`AgentSession.reloadSettings`), keeping what "always allow" granted → the settings again |
| `settings.setAutoMode {workspaceId, group, rules}` | replace one auto-mode group (`environment`, `allow`, `soft_deny`, `hard_deny`) in the user's settings, `null` for the built-in rules; live sessions take it up |
| `settings.setBackgroundProcesses {workspaceId, enabled}` | background commands on or off in the user's settings (`settings.get` says what each file has); sessions started afterwards have them |
| `autoMode.denials {workspaceId?}` | the live sessions auto mode refused something in (or paused in), each with its denials, newest first |
| `session.retryDenied {id, denialId}` | let the agent try a refused call once more — it's told so on its next turn |
| `memory.list {workspaceId}` | the instruction files (`AGENTS.md`, `CLAUDE.md` in `~/.agent/` and at the project's root — or the `AGENTS.md` to write) and the memories in the global and project stores, each with what's wrong with it, if sessions skip it |
| `memory.read` / `memory.write` / `memory.delete {workspaceId, target, text?}` | an instructions file or a memory (`{kind:'memory', scope, path}`): read, write (a memory must parse as one, in a scope that keeps its type; the store's `MEMORY.md` is written again) or delete (memories only) |
| `mcp.list {workspaceId}` | the MCP servers in `~/.agent/.mcp.json` and the project's `.mcp.json`, as the files have them (`${VAR}`s unexpanded, no headers or env), which one of a name is used, and how each signs in — OAuth ones, whether tokens are stored |
| `mcp.login {workspaceId, name}` | sign in to an OAuth server: answers with the page to authorize at, the callback caught on 127.0.0.1 as `marvis mcp login` does, and an `mcp_login` push when it ends — or at once when the tokens it has still work. Sessions started afterwards connect with it |
| `mcp.logout {workspaceId, name}` | forget a server's tokens |
| `stats.summary {workspaceId?, since?}` | every traced session started since then, in one project or all: each one's figures and the rollup across them — totals, averages, per model |
| `session.slashCommands {id}` | the session's MCP prompt commands |
| `session.skills {id}` | the session's skills (`/name [task]` loads one) |
| `session.close {id}` | close its live host (the log stays on disk) |
| `ask.answer`, `plan.answer` | answer a permission ask or a plan review |

## Events

`{t:'evt'}` frames carry `WireEvent`s (`packages/protocol/src/events.ts`): the
agent loop's `AgentEvent`s and `Notice`s forwarded as they are, plus the run
lifecycle (`run_start`, carrying the message's attachments, / `run_end` /
`run_error`), human-in-the-loop requests (`ask`, `plan`, `resolved`), the
queue (`queue`, the whole of it after every change) and state changes
(`mode`, `effort`, and `model`, which carries the effort levels, effort and
context meter that come with the new model). With background commands on
(`settings.backgroundProcesses`), `process_start`, `process_output` and
`process_end` follow each command the session started with
`run_in_background` — between runs too — and the snapshot's `processes`
carries each one's state and the last 64 KB it printed; a client folds them
with `foldProcesses`.

Every event gets a per-session, per-host `seq`, and the host keeps the last 5000
frames, so a client that reconnects resubscribes with its `lastSeq` and gets
just the gap. Clients fold events with the shared logic in
`packages/protocol/src/fold/` (`EventBuffer` + `foldReducer`), so the web and the
TUI agree on what a transcript is.

### Delta coalescing

`text_delta` and `thinking_delta` arrive from the model a token at a time. The
host buffers consecutive deltas of one type and flushes them as one event every
~30 ms, and immediately before any other event, so order is kept and every
socket sees ~30 frames/s instead of one per token. `EventBuffer` applies the same
rule on the client side.

`tool_call_output` — what a running `bash` prints, as it prints it (the tool's
`onOutput`; display only, the model still sees just the result) — coalesces the
same way, per call, and so does `process_output`, per background command. A flush carrying more than 16 KB keeps its tail, cut at a
line start and marked `…`; clients keep the last 32 KB of a call's output
(`appendOutput`) and drop it when the result arrives. `tool_call_end` carries
`durationMs`, the time the tool ran, permission prompt excluded (none for a
denied call, which never ran). The session log keeps it with the call
(`RecordedToolCall`), along with a `task`'s sub-agent calls — their long
strings cut to 4,000 characters — and both come back with the transcript in
its `tool_display` items; none of it is the model's history.

## Session lifecycle

A session is a log on disk (`.agent/sessions/<id>.jsonl`) and, while someone
is using it, a live host on the server: an `AgentSession` with its MCP
processes. The two are managed separately.

- **Viewing never resumes.** Opening a session in the UI calls
  `session.preview` and subscribes only if the session already has a live host
  (its snapshot carries an `epoch`). The first thing that acts on the session —
  a message, a mode change, opening the `/` menu for its MCP prompts — calls
  `session.open` and subscribes. Concurrent resumes of one session share one
  `AgentSession` (`registry.ensure`).
- **Drafts.** "New session" is the home route: a composer and nothing on the
  server. The first message calls `session.start`, whose snapshot is taken
  before the message is sent, so subscribing from seq 0 replays the startup
  notices and then the run.
- **Epochs.** A host resumed after its predecessor was closed restarts `seq` at
  0, so `seq`s only compare within one `epoch`. `session.subscribe` with an
  epoch other than the live host's always gets a reset.
- **Release.** A session the tab stops showing is unsubscribed after 15 s, or
  once nothing is running or waiting on the user. The server closes hosts that
  nobody is subscribed to, that aren't running or waiting on a prompt, after 10
  idle minutes (swept every minute); closing flushes the session's memory
  writes. The next action resumes it from disk.
- **Close** aborts a run that is still going and waits for it to wind down.
- **Metadata.** `sessions/<id>.meta.json` records the model, mode and effort a
  session last ran with, a given title, pin/archive flags, its creation time and
  cwd. It is written when a session's first run starts and patched on every
  change, atomically. Resuming restores the model (falling back to the default
  if it no longer resolves), the effort (if that model offers it), and the mode
  — except `yolo` and `auto`, which are never re-entered implicitly.
- **Delete** closes a live, idle session first (its writers would recreate the
  files), then removes its log, metadata, offloaded tool output and trace.
- **Abort** hands each run its own signal, so a Stop right after sending still
  lands, and an ask arriving after its run was aborted is refused rather than
  left waiting.
- **Queue.** A message sent while a run is going (or waiting on a prompt)
  waits in the host's queue — every client sees it, in `queue` events and the
  snapshot — and the oldest goes the moment the run ends, whatever ended it.
  Abort empties the queue and hands its messages back in its answer (the tab
  that stopped puts them in front of its draft); one sent after the Stop, while
  the run winds down, still goes. Closing a host sends nothing more.
- **Steering.** A message sent with `steer` waits in the same queue, marked
  `steer`, for the run itself: the loop asks for what the user said
  (`AgentLoopOptions.takeInput`) after each step's tool results — the text
  joins that results message, so the model reads it before its next request —
  and when the model ends its turn, where it becomes a new message and the run
  goes on. Several waiting are read as one message, their files first. A
  `user_input` event marks where it was read, and the message leaves the
  queue then; until then it can be taken back, Stop hands it back with the
  rest, and one the run never got to goes as the next message. A `/command`
  is never steered. Recorded with the step it joined, it reads back from disk
  as the user's message after that step. Nothing steered, the requests are
  byte-identical to before.
- **Switching models** (`session.setModel`) happens between runs. The history
  carries over; the effort is kept where the new model offers it and folded to
  its nearest level otherwise; compaction follows the model unless a small
  model is set; the system prompt starts fresh for the new model's cache; the
  meter is re-read against the new window. The auto-mode classifier keeps the
  model it started with. The metadata records the new model, so a resume uses
  it.
- **Attachments.** `@path` files a message carries are read with the `read`
  tool into blocks ahead of its text (`<attached_file path="…">`, line numbers
  and all) — the model sees them as it would a read, they enter the
  read-before-write ledger, and a recorded read call makes a resumed session
  remember them. Anything the session may not read is refused before a word is
  sent: outside the workspace, a secret or a denied path, not a regular file,
  binary, or over 256 KB (for those, mention the path and let the agent read
  what it needs). Titles and what a compaction keeps of the user's messages
  leave the file bodies out.
- **Images** (`images: [{mediaType, data}]`, base64 PNG, JPEG, GIF or WebP):
  up to eight a message, 5 MB each, for a model whose capabilities say it sees
  them (`vision`: GPT-4o, o-series, GPT-5, Claude via OpenRouter, the `-vl` /
  `-4v` / llava kinds) — refused as `bad_request` before anything is sent
  otherwise. They go in the message between attached files and the text, as
  `image_url` parts on the wire; a model switched to later that can't see them
  gets `[image]`. The log keeps them inline, so a transcript (and `run_start`,
  a queued message, `user_input`) carries them; the context estimate counts
  1.6K tokens each.
- **Rewind and fork.** A `rewind` event in the log keeps only the first N
  messages in force (`liveEvents`, which every replay of the log goes
  through): the model's history, the read ledger, a resume and the transcript
  all forget what came after, though the file still has it. A fork copies the
  events in force, as far as the cut, into a new log. Neither undoes what the
  agent did to files.
- **Skills** run as `/name [task]`: after the MCP prompts, the server expands a
  skill's name into the request to load it through the `skill` tool — the text
  the TUI's skill picker sends — with the rest of the line as the task.

### Worktrees

A session can work in a git worktree of its own (`session.start {worktree:
{base}}`, `server/src/worktrees.ts`), so two sessions — or a session and the
user — change one project at once without stepping on each other.

- **Made at start.** A branch `hc/<words of the first message>-<4 hex>` off
  `base` (a branch or commit), made `--no-track` — started from `origin/main`
  it would otherwise track it and a push would aim at `main` — checked out in
  `~/.agent/worktrees/<repo>-<hash>/<slug>`, outside the project, so no
  second checkout nests in it for searches, editors or `git status` to trip
  over. The session works at the workspace's place inside it (a workspace in
  a subdirectory of its repository stays in that subdirectory). A session
  that fails to start leaves neither the worktree nor the branch behind.
- **`.worktreeinclude`** at the repository's top lists, in `.gitignore`
  syntax, ignored files a new worktree gets a copy of — `.env`, local config —
  which a checkout never brings. Only ignored files: the patterns pick local
  ones, never what the branch carries.
- **The same project.** Core sees a linked worktree as its main checkout's
  project (`findStateRoot`, `core/config/settings.ts`): the session is logged,
  and reads its settings, memory and MCP servers, where the project's are;
  what the worktree checks out — `AGENTS.md`, skills, agents, plans — comes
  from the worktree. Its bash sandbox may write the repository's `.git`, where
  the worktree's index and refs live, and full tool outputs go to the system
  temp dir, where `read` can open them. The metadata records `worktree {path,
  branch, base}`; snapshots carry it with `cwd`, list rows the branch.
- **Archiving** removes the worktree — refused with `conflict` over
  uncommitted changes unless `force` — keeps the branch, and closes the
  terminals opened there; the row says `missing`. The session's next run
  checks the branch out again in a new worktree at the same place (a new
  branch off the base, if the branch was deleted meanwhile).
- **Deleting** removes the worktree, and the branch when git agrees it is
  merged (`branch -d`): a branch with work of its own stays. `--mock` sessions
  take their worktrees away when the server stops.

## Session list

`session.list` is fetched on every connect. After that the server pushes
changes: `session_upsert {summary}` whenever a session is created, resumed,
starts or ends a run, waits on or resolves a prompt, or is closed, and
`session_removed {id}` when a closed session has no log, and `workspaces` with
the whole list after a workspace is added or removed. `git_changed
{workspaceId}` says a session may have changed files there — after any tool
call but a lookup, and when a run ends, at most once per 250 ms — so a tab
showing that workspace's changes asks `git.status` again. `terminals
{workspaceId, terminals}` carries a workspace's whole list whenever a terminal
opens, exits or closes. `mcp_login {workspaceId, name, error?}` says how a
sign-in begun with `mcp.login` ended. Rows carry their
`workspaceId`, `pinned` and `archived`. Pushes carry current state, not deltas,
and are not replayed.

Each summary carries a `rev` from one server-wide counter; a list stamps all its
rows before reading anything, so of two rows for a session the higher `rev` is
newer, and a list built while a push was in flight can't roll that push back
(`lib/sessionList.ts`). `server.info.bootId` changes on every start; when it
changes, the list replaces the held rows outright.

The list also drives attention: the tab title counts sessions waiting on the
user, and, with the sidebar bell on, a system notification fires when a session
starts waiting or finishes while the app is not in front (`lib/attention.ts`).

## Security

The token is as powerful as the user's shell — a client can switch a session to
`yolo` — so:

1. **Loopback only.** The server binds `127.0.0.1`.
2. **Token.** 32 random bytes, stored in `~/.agent/web/token` (file 0600,
   directory 0700). It reaches the page as the URL fragment (`#token=…`), which
   is never sent to a server or logged; the page moves it to `localStorage` and
   scrubs it from the address bar. Compared in constant time.
3. **Origin and Host.** The WebSocket upgrade requires an exact `Origin` (the
   server's own, or `--dev-origin`) and a loopback `Host` header, both checked
   before the socket exists. Plain HTTP gets the same `Host` check, so a
   DNS-rebinding page can't read responses as same-origin.
4. **Static assets need no token.** They carry no data; everything that does
   goes over the authenticated socket.
5. **CSP.** Scripts, styles, fonts and images come from the page's own origin
   (images also `data:`), which also stops a prompt-injected markdown image from
   carrying data to another host; `frame-ancestors 'none'` and
   `X-Frame-Options: DENY` keep other sites from framing the page to trick clicks
   onto its approve buttons.
6. **No implicit escalation.** A resumed session never comes back in `yolo` or
   `auto`; those take a deliberate choice each time.
7. **Ids are ids.** Session ids end up in file paths, so every RPC accepts only
   an id's own characters; workspace ids are hex digests.
8. **Adding a project is trusting it.** Its `.mcp.json` commands run with every
   session and its settings apply; the add dialog shows both before it asks.
   Directory completion lists folder names, which the token already reaches.
9. **Diffs and the file viewer keep secrets on disk.** The Changes panel lists
   every changed file, but `git.diff` and `fs.read` withhold the contents of
   one the permission engine treats as a secret (`fs.read` also when a link
   leads to one), refuse a path outside the workspace, and follow no link out
   of it.
10. **A terminal is the user's shell.** It runs unsandboxed, with the server's
   environment, like a terminal the user opened — reachable only with the
   token, which is already as powerful.
11. **Attachments go through the permission engine.** `fs.search` lists a
   workspace's files without the ones the engine treats as secrets (`.env`,
   keys, credentials), and an attachment is checked as a `read` of that path
   would be: a deny rule or the sensitive-file stance refuses it.
12. **Worktrees live in the home directory, and copy only what they're told.**
   A session's worktree is under `~/.agent/worktrees/`; removing one deletes
   only a directory git registers as a worktree, or one under that directory.
   `.worktreeinclude` copies ignored files — secrets like `.env` included — only
   because the repository's owner named them there.

## The web app

- **Routes** are the URL hash: `#/` is the draft for a new session in the most
  recently used project, `#/new/<workspace>` one in a given project, `#/s/<id>`
  a session, `#/s/<id>/<id>` two side by side, `#/stats` the usage page,
  `#/settings/<section>` the settings (`lib/route.ts`). The draft picks the project, where the session works, mode,
  model and effort.
- **Split view** (`components/SessionArea.tsx`, `lib/split.ts`): two sessions
  side by side, each with its header, transcript and composer. ⌥-click a
  sidebar row, "Open beside" in its menu, or ⌥Enter on a session in the
  palette opens it next to the one on screen; each pane's × closes it. One
  pane has the focus — the last one clicked or typed in; the other's header
  is muted. The side panel (at the right edge) and the terminal (under both)
  are the focused session's, Esc stops its run, the palette acts on it, and a
  session opened from the sidebar or the palette takes its place (one already
  on screen just takes the focus). Only the focused pane's composer takes the
  focus when it mounts.
- **Where it works** (`WorktreePicker` in `components/ComposerControls.tsx`):
  the draft's first footer control — "Local", the project folder, or
  "Worktree" off one of the repository's branches (`git.branches`, loaded with
  the draft), the checked-out one first. The choice is kept per project
  (`lib/workPlace.ts`); a base since deleted falls back to the checked-out
  branch. Outside a repository, or in one without a commit, it isn't shown.
  A session in a worktree shows its branch in the header, and a branch icon
  in its sidebar row. Its side panel, terminal and `@` menu follow it
  (`lib/checkout.ts`: a `Checkout` is a workspace, plus the session for a
  worktree; git state is kept per checkout); once archiving removed the
  worktree, the Changes and Files tabs say so, and a new terminal starts in
  the project folder. Archiving one with uncommitted changes asks first
  (`components/ArchiveConflictDialog.tsx`), wherever it was asked for; the
  delete dialog says the worktree goes too.
- **Composer** (`components/Composer.tsx`): Enter sends, Shift+Enter is a new
  line, an IME's Enter only confirms. `/` at the start opens the command menu,
  `@` at the start of a word the file menu (`fs.search`); a picked file is
  attached while its `@path` stays in the text, shown as a chip, and kept with
  the draft across reloads. Images are pasted, dropped on the composer or picked
  with its image button (`lib/images.ts`: one bigger than 2048 px on its long
  edge, over 5 MB or in another format is redrawn as PNG or JPEG first), shown
  as thumbnails until sent and not kept across reloads; a model that can't see
  images (`model.list`'s `vision`) disables the button and says why. A message's
  images show as thumbnails that open whole. Its footer holds the mode chip (Shift+Tab cycles
  ask → acceptEdits → plan → auto), the model menu (each model's window, price
  and key status; `model.list` loads as it opens), the effort menu and, before
  the send button, the context ring that opens the breakdown and usage. While a
  run is going, Enter (or "Send now") steers it — the agent reads the message
  at its next step — and ⌥Enter (or Queue) waits for the turn to end; Stop sits
  beside them. Both kinds dock above the composer, steering ones first, each to
  edit or remove until it goes; a steered message appears in the transcript
  where the agent read it.
- **Commands** (`lib/slash.ts`): `/help`, `/clear`, `/model`, `/effort`,
  `/mode`, `/cost` and `/skills` stay in the page — given an argument they set
  it (`/effort max`, `/mode accept-edits`), without one they open their picker;
  `/compact`, `/plan`, MCP prompts and skills go to the server. Enter on a
  command typed out in full runs it; Tab completes.
- **Header**: the project, the title (click to rename) and the session's
  spend, which opens the same usage breakdown as the ring.
- **Command palette** (⌘K, `components/CommandPalette.tsx`): start a session
  or add a project; stop, rename, pin, archive or compact the session on
  screen, open its usage or skills, switch its mode, model or effort; jump to
  any session; switch the theme or the verbose transcript. ⇧⌘O starts a new
  session directly.
- **Sidebar** groups sessions by project (`lib/sidebar.ts`): pinned first, then
  newest, archived on request, a search across projects, rename in place and a
  ⋯ / right-click menu per row, and waiting / running / unread / time at the
  row's end.
- **State** is one zustand store (`lib/store.ts`): connection status, server
  info, workspaces, session rows, and the folded view of every opened session.
- **Sync** (`lib/sync.ts`) is the glue between the socket and the store: one
  `SessionModel` per opened session (`lib/sessionModel.ts`), published to the
  store at most once per animation frame.
- **Platform** (`platform.ts`) is the seam to the host environment — external
  links, notifications, storage — so a desktop shell can supply its own.
- **Transcript rows** (`lib/rows.ts`) fold startup notices into one "Session
  details" line, and make one row of each assistant turn — its committed steps
  and the one streaming — so two or more lookups in a row (`read`, `grep`,
  `glob`, `webfetch`, `list_skills`), with the thinking between them, fold into
  one line ("Read 3 files, searched for 2 patterns") that opens to the calls and
  names the one still running. Ctrl+O (Ctrl on a Mac too, as in the TUI) or the
  palette shows every call on its own instead; the choice is kept. Parts keep
  their keys when the streaming step commits, so what was opened mid-run stays
  open. Tool calls render through the per-tool registry
  (`components/tools/registry.tsx`). A `bash` card opens on its output while the
  command runs, following the tail, and folds again when it succeeds; its header
  gives the exit code of a failure (or the timeout) and the duration. Terminal
  colours are kept and other escapes dropped (`lib/ansi.ts`). `edit` and `write`
  cards show a unified diff (`components/DiffView.tsx`, `lib/diff.ts`) with the
  file's line numbers — a `write` over a file shows what changed in it, in
  hunks (`replaceDiff`), from the text it replaced (`ToolResult.display.before`,
  up to 128 KB), a new one the whole file; an `edit` with one replacement
  reports where it starts as `display.startLine`. `display` never reaches the
  model, is recorded with the call and comes back with the transcript as a
  `tool_display` item — Shiki colours for the file's language,
  and, within a removed line paired with the added one that replaced it, the
  words that changed. Past 400 lines a button shows the rest. A `task` card
  shows the sub-agent's calls as it makes them (`subagent_event`, the task
  tool's `onSubagentEvent`: starts and ends only), lookups folded as in a turn,
  open while it works, and again when the transcript is read back from disk.
  The sub-agent's `⤷` progress notices, which the TUI prints, get no row.
  Permission asks and plan reviews dock above the composer instead of opening
  modals (`components/PendingDock.tsx`); the ask for a `write` over a file
  carries the file as it is (`before`), so the dock shows what would change.
- **Copy, edit, fork, retry.** A finished turn's reply (its text, as
  markdown) and each message can be copied from a button that shows on hover.
  A user message's corner also has Edit — the conversation goes back to just
  before it (`session.rewind`; asked first when anything follows) and the
  message, files and images, goes back in the composer to change — and Fork,
  a new session with the conversation up to before it, the message in its
  composer, opened in the focused pane (`session.fork`; the palette forks the
  whole session). Under the last reply, Regenerate rewinds to before the last
  message and sends it again; after a run that failed or was stopped, or a
  message that never got a reply, Retry does the same, so the failed attempt
  leaves the conversation (`lastUserMessage`). None of these is offered while
  a run goes, and none touches the files.
- **Side panel** (`components/SidePanel.tsx`): to the right of a session,
  opened from the header or with ⌥⌘B (Ctrl+Alt+B); which tab shows is kept
  (`lib/panel.ts`). **Changes** (`components/ChangesPanel.tsx`) lists the
  project's changes against HEAD — branch and ahead/behind, then each file with
  a letter for its change and its line counts — and opens a file to its patch
  (`parsePatch`, hunks numbered from the file, the same diff view as the
  cards). "This session" narrows the list to the files the session's own
  `write` and `edit` calls touched, a sub-agent's included
  (`lib/sessionFiles.ts`) — what its `bash` commands changed can't be told
  apart. While it shows, `SessionSync.watchGit` keeps the status fresh: on
  every `git_changed` and reconnect, one load at a time; an open diff fetches
  again on each `git_changed`. git runs with optional locks off, so it never
  takes the index lock from a command the agent is running. Each row's
  checkbox stages or unstages the file (half-filled when part of it is staged),
  and its discard button throws the changes away once confirmed — saying when
  that deletes a file. The footer commits what is staged, or the files shown
  when nothing is (⌘↵ in the message), pushes (publishing a branch without an
  upstream) and opens a pull request with `gh`, saying what each did or git's
  reason it couldn't. Nothing prompts: a push that needs credentials fails
  rather than waiting on a terminal. Each change pushes `git_changed` to every
  tab. A file changed in place opens to its staged and unstaged changes apart
  (`hunkable`): each unstaged hunk has Stage and Discard (a second click
  confirms, within 4 s), each staged one Unstage. A new, deleted, renamed or
  conflicted file goes a file at a time, and shows all its changes against
  HEAD. Review comments sit on the unstaged side only — the staged side's line
  numbers are the index's, not the file the agent sees. **Files** (`components/FilesPanel.tsx`) is the project folder by
  folder (`fs.list`, refreshed with `git_changed`), or what a name search
  finds; a file opens in a viewer — line numbers and syntax colours, the diff
  view with nothing changed — with buttons to open it, at the line, in each
  editor the server found: a command-line tool on the PATH, else a Mac's
  installed app (VS Code and Cursor by their URL scheme, Zed by its bundled
  CLI) (`server/src/editors.ts`). Read, edit and write cards end with "Open
  file" (an edit at the line it starts on), and Changes rows with an open
  button (`openFile` in `lib/panel.ts`). **Review comments**
  (`components/ReviewComments.tsx`, `lib/review.ts`): in a Changes diff a
  line's number opens a comment under it — an added or unchanged line by its
  number now, a removed one by its old number; comments are kept per session
  across reloads, and a bar sends them to the session's agent as one message,
  file by file and line by line, each line quoted (queued if a run is going).
  **Tasks** shows the
  agent's task list whole; while it does, the task dock above the composer
  steps aside. **Trace** (`components/TracePanel.tsx`, `lib/trace.ts`) is the
  session's trace (`session.trace`), read again when a run ends: what it added
  up to — runs, model and tool calls, wall time, tokens, the share served from
  cache, cost — then each run as a waterfall, a row per model call and tool
  call placed on the run's span by when it started and how long it took, a
  failed or denied tool marked, compactions and provider errors between them.
  The last run is open, the rest fold to a line. With telemetry off
  (`telemetry.enabled: false`) there is nothing to show, and the tab says so.
  **Processes** (`components/ProcessesPanel.tsx`) appears once the session has
  started a command in the background (`backgroundProcesses` on, `bash` with
  `run_in_background`), the tab carrying how many still run: each command,
  newest first, with its status — running and for how long, its exit code,
  stopped — and Stop (`session.killProcess`) while it runs; one opens to what
  it printed, colours kept, following the tail. The one still running opens
  first. A `bash` card that started one says `background · bg1` and opens the
  tab on it (`openProcess`); `bash_output` and `bash_kill` cards are a line
  each. On a narrow panel the tabs keep their icons alone.
- **Usage** (`components/StatsView.tsx`, `#/stats`, from the chart icon in the
  sidebar's footer or the palette): `stats.summary` over the last 7, 30 or 90
  days or all time, in one project or all. The cost leads — the tokens, when no
  session in range has a price — then sessions, model and tool calls and
  tokens; cost per day as columns (tokens when nothing is priced; weeks past
  120 days), each with a tooltip on hover or focus and a table view; each
  model's share; and the sessions, the costliest first, each opening to its
  Trace tab. A session on a model without a price counts as `≥` what the rest
  cost, or `—` when nothing had one.
- **Settings** (`components/settings/`, `#/settings/<section>`, from the gear in
  the sidebar's footer or the palette), for the most recently used project or
  the one picked in the header — what's yours, every project's, beside what's
  the project's. **Permissions**: the allow, ask and deny lists of
  `~/.agent/settings.json` and the project's `.agent/settings.json`, a rule
  added on Enter and removed with its ×, the server's reason shown when one
  doesn't parse; the built-in allow rules folded below. **Auto mode**: why it's
  unavailable, if it is; what it refused in the open sessions, each with
  "Allow a retry" (`session.retryDenied`) and a paused session marked; the
  classifier's four groups, a group's built-in rules as one row that folds
  open (`$defaults` — removing it keeps only your own) and "Built-ins only" to
  go back to them. **Memory**: the instruction files — or the `AGENTS.md` to
  write — and each store's memories, opened in place in a mono field to edit
  (⌘↵ saves, Escape cancels); a memory sessions skip says why; delete arms
  first. **MCP servers**: each server as its file has it, the project's
  winning over yours by name; an OAuth one has Sign in — the page to
  authorize at opens in a new tab, "waiting for the browser" until the
  `mcp_login` push, then the list again — or Sign out. **Tools**: the switch
  for background commands in your settings (`settings.setBackgroundProcesses`),
  noting when the project's turn them on regardless; sessions started
  afterwards have them, as the tools a session shows the model are fixed when
  it starts.
- **Terminal** (`components/TerminalPanel.tsx`, `components/XTermView.tsx`):
  under the session, Ctrl+` (or the header button) shows and hides it, and its
  top edge drags to resize (both kept). A tab per shell of the project, + for
  another — opening the panel on a project without one starts one — and the
  title the shell sets as its label. The shells run on the server
  (`server/src/terminals.ts`, node-pty): the user's login shell in the
  project root, `TERM=xterm-256color`, not sandboxed. They outlive the page —
  attaching (and every reconnect) starts from what the terminal kept, its last
  256 KB of output — and are ended by closing their tab, removing the project
  or stopping the server. Output gathers for 8 ms per frame. xterm.js loads in
  its own chunk, on first use, themed from the app's tokens (converted to sRGB)
  and following theme changes. An Escape typed into a terminal is the shell's,
  never a Stop. Without node-pty (`capabilities.terminal` false) the panel says
  so. node-pty (1.2, prebuilt for macOS, Linux and Windows) is an optional
  dependency of the server and stays external to the bundles; the published
  package declares it optional.
- **Task list** (`components/TaskDock.tsx`): what the agent last passed to
  `todo` (`lib/todos.ts`, read off the transcript, so it survives a reload),
  docked above the composer while any of it is left — one line with progress
  and the task in hand that opens to the list — unless the side panel's Tasks
  tab shows it. `todo` cards in the transcript stay folded.
