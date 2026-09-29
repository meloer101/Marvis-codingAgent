/**
 * Wire-level frame shapes for the `hc web` WebSocket transport — one socket
 * per tab, carrying both RPC and the event stream. Verbatim from docs/web.md,
 * "Transport".
 */

import type { WireEvent } from './events.js';
import type { SessionSummary, Workspace } from './methods.js';

/** client → server */
export type ClientFrame = { t: 'req'; id: number; method: string; params: unknown };

/**
 * Server-wide state, pushed to every authenticated socket outside any
 * session's event stream: no `seq`, no replay. Each event carries current
 * state rather than a delta, so a reconnecting client just refetches
 * (`session.list`) and keeps, per session, whichever row has the newest `rev`.
 */
export type PushEvent =
  | { type: 'session_upsert'; summary: SessionSummary }
  | { type: 'session_removed'; id: string; rev: number }
  /** The whole workspace list, whenever a workspace is added or removed. */
  | { type: 'workspaces'; workspaces: Workspace[] };

/** server → client */
export type ServerFrame =
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } }
  | { t: 'evt'; sessionId: string; seq: number; event: WireEvent }
  | { t: 'push'; event: PushEvent };

export type ErrorCode = 'unauthorized' | 'not_found' | 'busy' | 'bad_request' | 'internal';