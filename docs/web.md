# hc web

`hc web` is the browser frontend: a local server (`packages/server`) that hosts
agent sessions for any number of projects, and a single-page app
(`packages/web`) that talks to it over one WebSocket per tab. `packages/protocol` holds everything both sides share: frame
and event types, the RPC method table (with zod schemas), and the event fold.
Planned work lives in [ROADMAP.md](./ROADMAP.md); the visual system in
[DESIGN.md](../DESIGN.md).

## Running it

```bash
hc web                 # serve the current directory; opens the browser
hc web --cwd ~/proj    # another workspace
hc web --mock          # scripted demo session, no API calls
hc web --rotate-token  # replace the saved access token
```

- **Port 4317** by default, bound to `127.0.0.1` only. If it is taken by
  something else, any free port is used. An explicit `--port` must be free.
- **One server for every project.** The server on the default port records
  itself in `~/.agent/web/server.json`; running `hc web` again finds it (live
  pid, and `GET /__hc/health` answers with the recorded boot id), adds the
  current directory to it as a project (`workspace.add`) and opens a new session
  there (`#token=…&w=<workspace>`) instead of starting a second server. The
  projects are remembered in `~/.agent/web/workspaces.json`.
- **One token per user**, in `~/.agent/web/token`, kept across restarts so
  bookmarks and open tabs keep working. `--mock` servers use a throwaway token
  and never record themselves.

**Development.** Run the server with the Vite dev server in front of it:

```bash
hc web --no-open --dev-origin http://localhost:5173 --port 4317
pnpm --filter @harness-code/web dev
```

The page is served by Vite and proxies `/ws` to the hc server (`HC_WEB_PORT`
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
- **Removing one** stops hosting it (its live sessions close, its files stay):
  not while one of its sessions runs, and never the last one.

## Transport

One socket per tab at `/ws`, carrying RPC and events as JSON frames
(`packages/protocol/src/frames.ts`):

| Frame | Direction | Carries |
|---|---|---|
| `{t:'req', id, method, params}` | client → server | an RPC call |
| `{t:'res', id, ok, result \| error}` | server → client | its answer; `error.code` is `unauthorized`, `not_found`, `busy`, `bad_request` or `internal` |
| `{t:'evt', sessionId, seq, event}` | server → client | one session's event stream, for sessions this socket subscribed to |
| `{t:'push', event}` | server → client | server-wide state, to every authenticated socket |

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
| `server.info` | version, `bootId`, and the launch workspace's defaults |
| `workspace.list` | every workspace with its defaults (model, mode, modes, effort levels, `keyProblem`) |
| `model.list {workspaceId?}` | the models a session there can be given, each with its windows, effort levels, price and why it can't run, if it can't |
| `workspace.inspect {path}` | what adding a directory would mean — nothing started |
| `workspace.add {path, createMarker?}` / `workspace.remove {id}` | host a project / stop hosting it |
| `fs.suggestDirs {prefix}` | directory completion for the add dialog |
| `git.status {workspaceId, sessionId?}` | the workspace's changes against HEAD: branch, upstream, ahead/behind, and per file its staged / unstaged change and lines added / removed |
| `git.diff {workspaceId, sessionId?, path}` | one file's patch against HEAD (an untracked file against nothing); binary, too big (> 1 MB) or a secret: withheld |
| `git.stage` / `git.unstage {workspaceId, sessionId?, paths}` | stage files as they are on disk (new files and deletions too) / take them out of the index |
| `git.revert {workspaceId, sessionId?, paths}` | throw changes away: back to HEAD (a rename to its old name), or deleted when HEAD lacks the file — never a secret |
| `git.commit {workspaceId, sessionId?, message, paths?}` | commit what is staged, staging `paths` first when given; hooks run → `{sha, summary}` |
| `git.push {workspaceId, sessionId?}` | push the branch; one without an upstream is published to `origin` (or the only remote) |
| `git.createPr {workspaceId, sessionId?, title, body?, draft?}` | `gh pr create` for the branch → `{url}` |
| `fs.search {workspaceId, query, limit?}` | a workspace's files matching an `@` query, best first; no ignored files, no secrets |
| `session.list` | every workspace's sessions (on disk plus live), newest first |
| `session.start {text, attachments?, workspaceId?, model?, mode?, effort?}` | create a session and send its first message (how a draft becomes a session); a bad attachment creates nothing |
| `session.create {workspaceId?, model?, mode?, effort?}` | create an empty live session |
| `session.preview {id}` | the live snapshot, or the transcript from disk — never resumes |
| `session.open {id}` | the live snapshot, resuming the session first if needed |
| `session.subscribe {id, sinceSeq?, epoch?}` | start receiving the session's events; replays the gap or answers `{reset, snapshot}` |
| `session.unsubscribe {id}` | stop receiving them |
| `session.send {id, text, attachments?}` | start a run, or queue the message behind the one going (`{runId}` or `{queued}`) |
| `session.unqueue {id, queuedId}` | take a queued message back before it goes |
| `session.abort {id}` | stop the run; pending prompts settle as a deny, and the queue comes back as `{unqueued}` |
| `session.setMode {id, mode}` | change the permission mode |
| `session.setModel {id, model}` | switch the model, history kept (`busy` mid-run, `bad_request` for a model that can't be resolved) |
| `session.setEffort {id, effort}` | change the reasoning effort, from the next message (`bad_request` for a level the model lacks) |
| `session.update {id, title?, pinned?, archived?}` | rename, pin, archive; answers with the new row |
| `session.delete {id}` | delete for good: log, metadata, offloaded output, trace (`busy` while it runs) |
| `session.compact {id}` | compact the history now (`busy` while a run is going) |
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
context meter that come with the new model).

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
same way, per call. A flush carrying more than 16 KB keeps its tail, cut at a
line start and marked `…`; clients keep the last 32 KB of a call's output
(`appendOutput`) and drop it when the result arrives. `tool_call_end` carries
`durationMs`, the time the tool ran, permission prompt excluded (none for a
denied call, which never ran); it isn't recorded, so a transcript read back from
disk has no durations.

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
- **Skills** run as `/name [task]`: after the MCP prompts, the server expands a
  skill's name into the request to load it through the `skill` tool — the text
  the TUI's skill picker sends — with the rest of the line as the task.

## Session list

`session.list` is fetched on every connect. After that the server pushes
changes: `session_upsert {summary}` whenever a session is created, resumed,
starts or ends a run, waits on or resolves a prompt, or is closed, and
`session_removed {id}` when a closed session has no log, and `workspaces` with
the whole list after a workspace is added or removed. `git_changed
{workspaceId}` says a session may have changed files there — after any tool
call but a lookup, and when a run ends, at most once per 250 ms — so a tab
showing that workspace's changes asks `git.status` again. Rows carry their
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
9. **Diffs keep secrets on disk.** The Changes panel lists every changed file,
   but `git.diff` withholds the contents of one the permission engine treats as
   a secret, and refuses a path outside the workspace.
10. **Attachments go through the permission engine.** `fs.search` lists a
   workspace's files without the ones the engine treats as secrets (`.env`,
   keys, credentials), and an attachment is checked as a `read` of that path
   would be: a deny rule or the sensitive-file stance refuses it.

## The web app

- **Routes** are the URL hash: `#/` is the draft for a new session in the most
  recently used project, `#/new/<workspace>` one in a given project, `#/s/<id>`
  a session (`lib/route.ts`). The draft picks the project, mode, model and
  effort.
- **Composer** (`components/Composer.tsx`): Enter sends, Shift+Enter is a new
  line, an IME's Enter only confirms. `/` at the start opens the command menu,
  `@` at the start of a word the file menu (`fs.search`); a picked file is
  attached while its `@path` stays in the text, shown as a chip, and kept with
  the draft across reloads. Its footer holds the mode chip (Shift+Tab cycles
  ask → acceptEdits → plan → auto), the model menu (each model's window, price
  and key status; `model.list` loads as it opens), the effort menu and, before
  the send button, the context ring that opens the breakdown and usage. While a
  run is going Stop sits beside a Queue button; queued messages dock above the
  composer, each to edit or remove.
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
  file's line numbers — a `write` is the whole file; an `edit` with one
  replacement reports where it starts as `ToolResult.display.startLine`, which
  never reaches the model, is recorded with the call and comes back with the
  transcript as a `tool_display` item — Shiki colours for the file's language,
  and, within a removed line paired with the added one that replaced it, the
  words that changed. Past 400 lines a button shows the rest. A `task` card
  shows the sub-agent's calls as it makes them (`subagent_event`, the task
  tool's `onSubagentEvent`: starts and ends only), lookups folded as in a turn,
  open while it works; they aren't recorded, so a transcript read back from
  disk has the prompt and the report only. The sub-agent's `⤷` progress
  notices, which the TUI prints, get no row. Permission asks
  and plan reviews dock above the composer instead of opening modals
  (`components/PendingDock.tsx`).
- **Copy and retry.** A finished turn's reply (its text, as markdown) and each
  message can be copied from a button that shows on hover. After a run that
  failed or was stopped — its error notice ends the transcript — or a message
  that never got a reply, Retry sends that message again with its attachments
  (`retryTarget`). It is a new message, not a rewind: the failed attempt stays
  in the history.
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
  tab. **Tasks** shows the
  agent's task list whole; while it does, the task dock above the composer
  steps aside.
- **Task list** (`components/TaskDock.tsx`): what the agent last passed to
  `todo` (`lib/todos.ts`, read off the transcript, so it survives a reload),
  docked above the composer while any of it is left — one line with progress
  and the task in hand that opens to the list — unless the side panel's Tasks
  tab shows it. `todo` cards in the transcript stay folded.
