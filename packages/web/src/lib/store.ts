import { create } from 'zustand';

import type { SlashCommandInfo } from '@harness-code/core';
import type { ModelInfo, ServerInfo, SessionSummary, Workspace } from '@harness-code/protocol';

import type { ConnectionStatus } from './rpc';
import type { SessionViewState } from './sessionModel';

export interface AppState {
  status: ConnectionStatus;
  info: ServerInfo | null;
  /** The projects the server hosts, most recently used first. */
  workspaces: Workspace[];
  /** Sidebar rows, newest first (server order). */
  sessions: SessionSummary[];
  /** Folded state per opened session, published once per animation frame. */
  views: Record<string, SessionViewState>;
  /** MCP prompt commands per session, for the `/` menu. */
  slash: Record<string, SlashCommandInfo[]>;
  /** The models on offer per workspace, loaded when a model picker opens. */
  models: Record<string, ModelInfo[]>;
  /**
   * What to put back in a session's composer: queued messages a Stop handed
   * back, or one taken out of the queue to edit. The composer takes it once.
   */
  restored: Record<string, { text: string; attachments: string[] }>;
  /** Last failed action, shown as a dismissible banner. */
  error: string | null;
  /** The `/help` panel. */
  helpOpen: boolean;
  /** The "add project" dialog. */
  addProjectOpen: boolean;
}

export const useAppStore = create<AppState>(() => ({
  status: 'closed',
  info: null,
  workspaces: [],
  sessions: [],
  views: {},
  slash: {},
  models: {},
  restored: {},
  error: null,
  helpOpen: false,
  addProjectOpen: false,
}));
