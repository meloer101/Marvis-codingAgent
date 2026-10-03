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
| `server.info` | version, `bootId`, the launch workspace's defaults, the editors files can be opened in, and `capabilities.terminal` (node-pty loaded) |
| `workspace.list` | every workspace with its defaults (model, mode, modes, effort levels, `keyProblem`) |
| `model.list {workspaceId?}` | the models a session there can be given, each with its windows, effort levels, price and why it can't run, if it can't |
| `workspace.inspect {path}` | what adding a directory would mean — nothing started |
| `workspace.add {path, createMarker?}` / `workspace.remove {id}` | host a project / stop hosting it |
| `fs.suggestDirs {prefix}` | directory completion for the add dialog |
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
| `session.start {text, attachments?, workspaceId?, model?, mode?, effort?, worktree?}` | create a session and send its first message (how a draft becomes a session); a bad attachment creates nothing. `worktree {base}`: in a git worktree of its own, on a new branch off `base` |
| `session.create {workspaceId?, model?, mode?, effort?}` | create an empty live session |
| `session.preview {id}` | the live snapshot, or the transcript from disk — never resumes |
| `session.open {id}` | the live snapshot, resuming the session first if needed |
| `session.subscribe {id, sinceSeq?, epoch?}` | start receiving the session's events; replays the gap or answers `{reset, snapshot}` |
| `session.unsubscribe {id}` | stop receiving them |
| `session.send {id, text, attachments?, steer?}` | start a run, or queue the message behind the one going (`{runId}` or `{queued}`); with `steer`, the run reads it at its next step |
| `session.unqueue {id, queuedId}` | take a queued message back before it goes |
| `session.abort {id}` | stop the run; pending prompts settle as a deny, and the queue comes back as `{unqueued}` |
| `session.setMode {id, mode}` | change the permission mode |
| `session.setModel {id, model}` | switch the model, history kept (`busy` mid-run, `bad_request` for a model that can't be resolved) |
| `session.setEffort {id, effort}` | change the reasoning effort, from the next message (`bad_request` for a level the model lacks) |
| `session.update {id, title?, pinned?, archived?, force?}` | rename, pin, archive; answers with the new row. Archiving removes the session's worktree: `conflict` over uncommitted changes there, unless `force` |
| `session.delete {id}` | delete for good: log, metadata, offloaded output, trace, worktree (`busy` while it runs) |
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
opens, exits or closes. Rows carry their
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
  a session, `#/s/<id>/<id>` two side by side (`lib/route.ts`). The draft picks
  the project, where the session works, mode, model and effort.
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
  the draft across reloads. Its footer holds the mode chip (Shift+Tab cycles
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
  steps aside.
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
