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
| `workspace.inspect {path}` | what adding a directory would mean — nothing started |
| `workspace.add {path, createMarker?}` / `workspace.remove {id}` | host a project / stop hosting it |
| `fs.suggestDirs {prefix}` | directory completion for the add dialog |
| `session.list` | every workspace's sessions (on disk plus live), newest first |
| `session.start {text, workspaceId?, model?, mode?, effort?}` | create a session and send its first message (how a draft becomes a session) |
| `session.create {workspaceId?, model?, mode?, effort?}` | create an empty live session |
| `session.preview {id}` | the live snapshot, or the transcript from disk — never resumes |
| `session.open {id}` | the live snapshot, resuming the session first if needed |
| `session.subscribe {id, sinceSeq?, epoch?}` | start receiving the session's events; replays the gap or answers `{reset, snapshot}` |
| `session.unsubscribe {id}` | stop receiving them |
| `session.send {id, text}` | start a run (`busy` while one is going) |
| `session.abort {id}` | stop the run; pending prompts settle as a deny |
| `session.setMode {id, mode}` | change the permission mode |
| `session.setEffort {id, effort}` | change the reasoning effort, from the next message (`bad_request` for a level the model lacks) |
| `session.update {id, title?, pinned?, archived?}` | rename, pin, archive; answers with the new row |
| `session.delete {id}` | delete for good: log, metadata, offloaded output, trace (`busy` while it runs) |
| `session.compact {id}` | compact the history now (`busy` while a run is going) |
| `session.slashCommands {id}` | the session's MCP prompt commands |
| `session.close {id}` | close its live host (the log stays on disk) |
| `ask.answer`, `plan.answer` | answer a permission ask or a plan review |

## Events

`{t:'evt'}` frames carry `WireEvent`s (`packages/protocol/src/events.ts`): the
agent loop's `AgentEvent`s and `Notice`s forwarded as they are, plus the run
lifecycle (`run_start` / `run_end` / `run_error`), human-in-the-loop requests
(`ask`, `plan`, `resolved`) and mode and effort changes (`mode`, `effort`).

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

## Session list

`session.list` is fetched on every connect. After that the server pushes
changes: `session_upsert {summary}` whenever a session is created, resumed,
starts or ends a run, waits on or resolves a prompt, or is closed, and
`session_removed {id}` when a closed session has no log, and `workspaces` with
the whole list after a workspace is added or removed. Rows carry their
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

## The web app

- **Routes** are the URL hash: `#/` is the draft for a new session in the most
  recently used project, `#/new/<workspace>` one in a given project, `#/s/<id>`
  a session (`lib/route.ts`). The draft picks the project, mode and effort.
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
- **Transcript rows** fold startup notices into one "Session details" line
  (`lib/rows.ts`); tool calls render through the per-tool registry
  (`components/tools/registry.tsx`); permission asks and plan reviews dock above
  the composer instead of opening modals (`components/PendingDock.tsx`).
