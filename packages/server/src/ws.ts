/**
 * The WebSocket transport: one socket per browser tab carrying both RPC and
 * the event stream (docs/web.md, "Transport"). This module owns three things:
 *
 *  - **Handshake security.** Before the HTTP upgrade completes, the `Origin`
 *    must match the server's own origin and the `Host` header must be a
 *    loopback `host:port` — a browser page on any other origin, and a DNS-
 *    rebinding attempt, are both refused here (docs/web.md, "Security" 3).
 *  - **Auth.** The first frame on every socket must be `auth` carrying the
 *    per-server token, compared with `timingSafeEqual`. Anything else closes
 *    the socket.
 *  - **RPC dispatch + subscribe.** Client frames are validated with the exact
 *    zod schemas from `@harness-code/protocol`'s method table, dispatched to
 *    the workspace hub / session host, and answered. `session.subscribe` either replays the
 *    gap since `sinceSeq` from the host ring or answers `{ reset, snapshot }`.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import type {
  ClientFrame,
  ErrorCode,
  MethodName,
  MethodParams,
  ServerFrame,
  ServerInfo,
} from '@harness-code/protocol';
import { methods } from '@harness-code/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import { BusyError, ConflictError, InvalidRequestError, SessionNotFoundError } from './host.js';
import {
  GitCommandError,
  createPullRequest,
  gitApplyHunk,
  gitCommit,
  gitPush,
  gitRevert,
  gitStage,
  gitUnstage,
} from './git.js';
import { WorkspaceNotFoundError } from './hub.js';
import { WorkspacePathError } from './paths.js';
import { TerminalNotFoundError } from './terminals.js';
import { suggestDirs } from './inspect.js';
import type { WorkspaceHub } from './hub.js';
import { SessionPreviewNotFoundError } from './registry.js';
import type { SessionHost } from './host.js';

export interface WsServerOptions {
  httpServer: HttpServer;
  hub: WorkspaceHub;
  /** The per-server secret; the first frame must present it. */
  token: string;
  /** Exact `Origin` values allowed to upgrade (own origin, plus any dev origin). */
  allowedOrigins: ReadonlySet<string>;
  /** Allowed `Host` header values — loopback `host:port` only. */
  allowedHosts: ReadonlySet<string>;
  /** Computes the `server.info` payload lazily (settings can change on disk). */
  serverInfo: () => Promise<ServerInfo> | ServerInfo;
  /** Upgrade path. Defaults to `/ws`. */
  path?: string;
}

/**
 * Attach a WebSocket server to `httpServer`, handling the upgrade ourselves so
 * we can reject a bad `Origin`/`Host` before the socket is even created. Returns
 * the `WebSocketServer` so the caller can close it on shutdown.
 */
export function attachWsServer(opts: WsServerOptions): WebSocketServer {
  const { httpServer } = opts;
  const path = opts.path ?? '/ws';
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // A peer that resets a rejected upgrade would otherwise raise an unhandled
    // 'error' on this raw socket and crash the process — swallow it.
    socket.on('error', () => {});

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== path) {
      socket.destroy();
      return;
    }
    if (!originOk(req, opts.allowedOrigins) || !hostOk(req, opts.allowedHosts)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };
  httpServer.on('upgrade', onUpgrade);
  wss.once('close', () => httpServer.off('upgrade', onUpgrade));

  wss.on('connection', (ws: WebSocket) => {
    new Connection(ws, opts);
  });

  return wss;
}

/** Exact-match the `Origin` header against the allow set (a missing Origin is refused). */
function originOk(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && allowed.has(origin);
}

/** The `Host` header must be one of the loopback `host:port` values we bound. */
function hostOk(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const host = req.headers.host;
  return typeof host === 'string' && allowed.has(host);
}

/** Constant-time token comparison that never throws on a length mismatch. */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** WS close code for a failed/absent auth. 4001 is an app-defined code (>= 4000). */
const CLOSE_UNAUTHORIZED = 4001;

/**
 * One client socket. Tracks auth state and this socket's per-session event
 * subscriptions; every subscription is torn down when the socket closes (the
 * host itself lives on — sessions survive a disconnect, docs/web.md).
 */
class Connection {
  #authed = false;
  readonly #subs = new Map<string, () => void>();
  /** Stops forwarding session-list pushes; set once the socket authenticates. */
  #unwatch: (() => void) | undefined;
  /** Terminals this socket receives the output of. */
  readonly #terminals = new Map<string, () => void>();

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: WsServerOptions,
  ) {
    ws.on('message', (data: Buffer) => {
      void this.#onMessage(data.toString());
    });
    ws.on('close', () => {
      for (const unsub of this.#subs.values()) unsub();
      this.#subs.clear();
      for (const detach of this.#terminals.values()) detach();
      this.#terminals.clear();
      this.#unwatch?.();
    });
    // A socket-level error just means the peer went away; teardown runs on 'close'.
    ws.on('error', () => {});
  }

  async #onMessage(raw: string): Promise<void> {
    let frame: ClientFrame;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isClientFrame(parsed)) throw new Error('bad frame');
      frame = parsed;
    } catch {
      // Unparseable / malformed frame: nothing to reply to. Close the socket.
      this.ws.close();
      return;
    }

    if (!this.#authed) {
      this.#handleAuth(frame);
      return;
    }
    await this.#dispatch(frame);
  }

  /** The first frame must be `auth { token }`; anything else, or a bad token, closes the socket. */
  #handleAuth(frame: ClientFrame): void {
    if (frame.method !== 'auth') {
      this.#replyError(frame.id, 'unauthorized', 'the first frame must be "auth"');
      this.ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    const params = frame.params as { token?: unknown } | null;
    const token = params && typeof params.token === 'string' ? params.token : '';
    if (!tokensEqual(token, this.opts.token)) {
      this.#replyError(frame.id, 'unauthorized', 'invalid token');
      this.ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    this.#authed = true;
    this.#replyOk(frame.id, { ok: true });
    // Session-list changes reach every authenticated socket, subscribed or not:
    // the sidebar badges every session, not just the ones this tab has open.
    this.#unwatch = this.opts.hub.onChange((event) => this.#send({ t: 'push', event }));
  }

  async #dispatch(frame: ClientFrame): Promise<void> {
    if (frame.method === 'session.subscribe') {
      await this.#subscribe(frame);
      return;
    }
    if (frame.method === 'session.unsubscribe') {
      this.#unsubscribe(frame);
      return;
    }

    const spec = methods[frame.method as MethodName];
    if (!spec) {
      this.#replyError(frame.id, 'bad_request', `unknown method "${frame.method}"`);
      return;
    }
    const parsed = spec.params.safeParse(frame.params);
    if (!parsed.success) {
      this.#replyError(frame.id, 'bad_request', `invalid params: ${parsed.error.message}`);
      return;
    }
    try {
      const result = await this.#invoke(frame.method as MethodName, parsed.data);
      this.#replyOk(frame.id, result);
    } catch (err) {
      const { code, message } = mapError(err);
      this.#replyError(frame.id, code, message);
    }
  }

  #invoke(method: MethodName, params: unknown): Promise<unknown> | unknown {
    const { hub } = this.opts;
    switch (method) {
      case 'server.info':
        return this.opts.serverInfo();
      case 'workspace.list':
        return hub.workspaces();
      case 'workspace.inspect':
        return hub.inspect((params as MethodParams<'workspace.inspect'>).path);
      case 'workspace.add': {
        const { path, createMarker } = params as MethodParams<'workspace.add'>;
        return hub.add(path, createMarker !== undefined ? { createMarker } : {});
      }
      case 'workspace.remove':
        return hub.remove((params as MethodParams<'workspace.remove'>).id);
      case 'model.list':
        return hub.models((params as MethodParams<'model.list'>).workspaceId);
      case 'fs.search': {
        const { workspaceId, sessionId, query, limit } = params as MethodParams<'fs.search'>;
        return hub.searchFiles(workspaceId, query, limit, sessionId);
      }
      case 'terminal.list':
        return hub.terminals.list((params as MethodParams<'terminal.list'>).workspaceId);
      case 'terminal.create': {
        const { workspaceId, sessionId, cols, rows } = params as MethodParams<'terminal.create'>;
        return hub.createTerminal(workspaceId, cols, rows, sessionId);
      }
      case 'terminal.attach': {
        const { id } = params as MethodParams<'terminal.attach'>;
        this.#terminals.get(id)?.();
        const { detach, ...attached } = hub.terminals.attach(id, (out) => this.#send({ t: 'term', id, ...out }));
        this.#terminals.set(id, detach);
        return attached;
      }
      case 'terminal.detach': {
        const { id } = params as MethodParams<'terminal.detach'>;
        this.#terminals.get(id)?.();
        this.#terminals.delete(id);
        return undefined;
      }
      case 'terminal.input': {
        const { id, data } = params as MethodParams<'terminal.input'>;
        hub.terminals.input(id, data);
        return undefined;
      }
      case 'terminal.resize': {
        const { id, cols, rows } = params as MethodParams<'terminal.resize'>;
        hub.terminals.resize(id, cols, rows);
        return undefined;
      }
      case 'terminal.close': {
        const { id } = params as MethodParams<'terminal.close'>;
        this.#terminals.get(id)?.();
        this.#terminals.delete(id);
        hub.terminals.close(id);
        return undefined;
      }
      case 'fs.list': {
        const { workspaceId, sessionId, dir } = params as MethodParams<'fs.list'>;
        return hub.listDir(workspaceId, dir, sessionId);
      }
      case 'fs.read': {
        const { workspaceId, sessionId, path } = params as MethodParams<'fs.read'>;
        return hub.readFile(workspaceId, path, sessionId);
      }
      case 'editor.open': {
        const { workspaceId, sessionId, path, line, editor } = params as MethodParams<'editor.open'>;
        return hub.openInEditor(workspaceId, path, editor, line, sessionId);
      }
      case 'git.status': {
        const { workspaceId, sessionId } = params as MethodParams<'git.status'>;
        return hub.gitStatus(workspaceId, sessionId);
      }
      case 'git.diff': {
        const { workspaceId, sessionId, path, side } = params as MethodParams<'git.diff'>;
        return hub.gitDiff(workspaceId, path, sessionId, side);
      }
      case 'git.applyHunk': {
        const { workspaceId, sessionId, path, hunk, action } = params as MethodParams<'git.applyHunk'>;
        return hub.gitChange(workspaceId, (root) => gitApplyHunk(root, path, hunk, action), sessionId);
      }
      case 'git.branches':
        return hub.gitBranches((params as MethodParams<'git.branches'>).workspaceId);
      case 'git.stage': {
        const { workspaceId, sessionId, paths } = params as MethodParams<'git.stage'>;
        return hub.gitChange(workspaceId, (root) => gitStage(root, paths), sessionId);
      }
      case 'git.unstage': {
        const { workspaceId, sessionId, paths } = params as MethodParams<'git.unstage'>;
        return hub.gitChange(workspaceId, (root) => gitUnstage(root, paths), sessionId);
      }
      case 'git.revert': {
        const { workspaceId, sessionId, paths } = params as MethodParams<'git.revert'>;
        return hub.gitChange(workspaceId, (root) => gitRevert(root, paths), sessionId);
      }
      case 'git.commit': {
        const { workspaceId, sessionId, message, paths } = params as MethodParams<'git.commit'>;
        return hub.gitChange(workspaceId, (root) => gitCommit(root, message, paths ? { paths } : {}), sessionId);
      }
      case 'git.push': {
        const { workspaceId, sessionId } = params as MethodParams<'git.push'>;
        return hub.gitChange(workspaceId, (root) => gitPush(root), sessionId);
      }
      case 'git.createPr': {
        const { workspaceId, sessionId, title, body, draft } = params as MethodParams<'git.createPr'>;
        return hub.gitChange(
          workspaceId,
          (root, checkout) =>
            createPullRequest(root, {
              title,
              ...(body !== undefined ? { body } : {}),
              ...(draft !== undefined ? { draft } : {}),
              ...(checkout.worktree ? { base: checkout.worktree.base } : {}),
            }),
          sessionId,
        );
      }
      case 'fs.suggestDirs':
        return suggestDirs((params as MethodParams<'fs.suggestDirs'>).prefix);
      case 'session.list':
        return hub.list();
      case 'session.create':
        return hub.create(params as MethodParams<'session.create'>);
      case 'session.start':
        return hub.start(params as MethodParams<'session.start'>);
      case 'session.open':
        return hub.open((params as MethodParams<'session.open'>).id);
      case 'session.preview':
        return hub.preview((params as MethodParams<'session.preview'>).id);
      case 'session.unsubscribe':
      case 'session.subscribe':
        // Handled before dispatch; unreachable.
        throw new Error('unreachable');
      case 'session.send': {
        const { id, text, attachments, steer } = params as MethodParams<'session.send'>;
        return this.#host(id).send(text, attachments, steer !== undefined ? { steer } : {});
      }
      case 'session.abort': {
        const { id } = params as MethodParams<'session.abort'>;
        return this.#host(id).abort();
      }
      case 'session.unqueue': {
        const { id, queuedId } = params as MethodParams<'session.unqueue'>;
        return this.#host(id).unqueue(queuedId);
      }
      case 'session.setMode': {
        const { id, mode } = params as MethodParams<'session.setMode'>;
        this.#host(id).setMode(mode);
        return undefined;
      }
      case 'session.setModel': {
        const { id, model } = params as MethodParams<'session.setModel'>;
        this.#host(id).setModel(model);
        return undefined;
      }
      case 'session.setEffort': {
        const { id, effort } = params as MethodParams<'session.setEffort'>;
        this.#host(id).setEffort(effort);
        return undefined;
      }
      case 'session.compact': {
        const { id } = params as MethodParams<'session.compact'>;
        return this.#host(id).compact();
      }
      case 'session.slashCommands': {
        const { id } = params as MethodParams<'session.slashCommands'>;
        return this.#host(id).slashCommands();
      }
      case 'session.skills': {
        const { id } = params as MethodParams<'session.skills'>;
        return this.#host(id).skills();
      }
      case 'session.close': {
        const { id } = params as MethodParams<'session.close'>;
        return hub.close(id);
      }
      case 'session.update': {
        const { id, ...patch } = params as MethodParams<'session.update'>;
        return hub.update(id, patch);
      }
      case 'session.delete':
        return hub.delete((params as MethodParams<'session.delete'>).id);
      case 'ask.answer': {
        const { sessionId, askId, decision, feedback } = params as MethodParams<'ask.answer'>;
        this.#host(sessionId).answerAsk(askId, decision, feedback);
        return undefined;
      }
      case 'plan.answer': {
        const { sessionId, planId, approved, feedback, mode } = params as MethodParams<'plan.answer'>;
        this.#host(sessionId).answerPlan(planId, approved, feedback, mode);
        return undefined;
      }
      default: {
        const exhaustive: never = method;
        throw new Error(`unhandled method ${String(exhaustive)}`);
      }
    }
  }

  #host(id: string): SessionHost {
    const host = this.opts.hub.host(id);
    if (!host) throw new SessionNotFoundError(id);
    return host;
  }

  // -- subscribe / unsubscribe ----------------------------------------------

  async #subscribe(frame: ClientFrame): Promise<void> {
    const parsed = methods['session.subscribe'].params.safeParse(frame.params);
    if (!parsed.success) {
      this.#replyError(frame.id, 'bad_request', `invalid params: ${parsed.error.message}`);
      return;
    }
    const { id, sinceSeq, epoch } = parsed.data;
    const host = this.opts.hub.host(id);
    if (!host) {
      this.#replyError(frame.id, 'not_found', `no live session "${id}"`);
      return;
    }

    // Re-subscribing on the same socket replaces the previous listener.
    this.#subs.get(id)?.();
    this.#subs.delete(id);

    // Fast path: the ring still covers the gap — replay it, no snapshot.
    // Attaching the listener and reading the ring is synchronous, so no event
    // can slip through in between, and replayed (past) frames never overlap
    // with the future frames the listener forwards. `seq`s from another epoch
    // (the host was closed and the session resumed since) mean nothing here.
    const sameHost = epoch === undefined || epoch === host.epoch;
    if (sinceSeq !== undefined && sameHost && host.canReplay(sinceSeq)) {
      const unsub = host.addListener((f) => this.#sendFrame(f));
      this.#subs.set(id, unsub);
      this.#replyOk(frame.id, { lastSeq: host.lastSeq });
      for (const f of host.since(sinceSeq)) this.#sendFrame(f);
      return;
    }

    // Reset path: snapshot is async, so buffer any events emitted while we
    // build it and flush them (in order, after the reset response) once done —
    // the client always sees the snapshot before the events that follow it.
    const buffer: ServerFrame[] = [];
    let flushing = false;
    const unsub = host.addListener((f) => {
      if (flushing) this.#sendFrame(f);
      else buffer.push(f);
    });
    this.#subs.set(id, unsub);
    const snapshot = await host.snapshot();
    this.#replyOk(frame.id, { reset: true, snapshot });
    flushing = true;
    for (const f of buffer) {
      if (f.t === 'evt' && f.seq > snapshot.lastSeq) this.#sendFrame(f);
    }
  }

  #unsubscribe(frame: ClientFrame): void {
    const parsed = methods['session.unsubscribe'].params.safeParse(frame.params);
    if (!parsed.success) {
      this.#replyError(frame.id, 'bad_request', `invalid params: ${parsed.error.message}`);
      return;
    }
    const { id } = parsed.data;
    this.#subs.get(id)?.();
    this.#subs.delete(id);
    this.#replyOk(frame.id, undefined);
  }

  // -- frame writers --------------------------------------------------------

  #replyOk(id: number, result: unknown): void {
    this.#send({ t: 'res', id, ok: true, result });
  }

  #replyError(id: number, code: ErrorCode, message: string): void {
    this.#send({ t: 'res', id, ok: false, error: { code, message } });
  }

  #sendFrame(frame: ServerFrame): void {
    this.#send(frame);
  }

  #send(frame: ServerFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }
}

function isClientFrame(value: unknown): value is ClientFrame {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return f.t === 'req' && typeof f.id === 'number' && typeof f.method === 'string';
}

/** Map a thrown value to a wire error code. */
function mapError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof BusyError) return { code: 'busy', message: err.message };
  if (err instanceof ConflictError) return { code: 'conflict', message: err.message };
  if (err instanceof InvalidRequestError) return { code: 'bad_request', message: err.message };
  if (err instanceof SessionNotFoundError) return { code: 'not_found', message: err.message };
  if (err instanceof SessionPreviewNotFoundError) return { code: 'not_found', message: err.message };
  if (err instanceof WorkspaceNotFoundError) return { code: 'not_found', message: err.message };
  if (err instanceof WorkspacePathError) return { code: 'bad_request', message: err.message };
  if (err instanceof TerminalNotFoundError) return { code: 'not_found', message: err.message };
  if (err instanceof GitCommandError) return { code: 'bad_request', message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message };
}
