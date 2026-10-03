import { create } from 'zustand';

import type { ImageInput, SlashCommandInfo } from '@harness-code/core';
import type {
  GitBranches,
  GitStatus,
  ModelInfo,
  ServerInfo,
  SessionSummary,
  SkillInfo,
  TerminalInfo,
  Workspace,
} from '@harness-code/protocol';

import type { ConnectionStatus } from './rpc';
import type { CommandSurface } from './slash';
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
  /** Installed skills per session, for the `/` menu and `/skills`. */
  skills: Record<string, SkillInfo[]>;
  /** The models on offer per workspace, loaded when a model picker opens. */
  models: Record<string, ModelInfo[]>;
  /** Git state per checkout something is showing, by `checkoutKey` (`SessionSync.watchGit`). */
  git: Record<string, GitStatus>;
  /** Each workspace's branches, for a new session's worktree (`SessionSync.loadBranches`). */
  branches: Record<string, GitBranches>;
  /** Counts the `git_changed` pushes per workspace, so an open diff knows to fetch again. */
  gitRev: Record<string, number>;
  /** Each workspace's terminals, oldest first (`terminal.list`, then `terminals` pushes). */
  terminals: Record<string, TerminalInfo[]>;
  /**
   * What to put back in a session's composer: queued messages a Stop handed
   * back, or one taken out of the queue to edit. The composer takes it once.
   */
  restored: Record<string, { text: string; attachments: string[]; images?: ImageInput[]; inline?: boolean }>;
  /** Last failed action, shown as a dismissible banner. */
  error: string | null;
  /** An archive the server refused over a worktree's uncommitted changes, waiting on the user to confirm. */
  archiveConflict: { id: string; reason: string } | null;
  /** The `/help` panel. */
  helpOpen: boolean;
  /** The "add project" dialog. */
  addProjectOpen: boolean;
  /** The command palette (⌘K). */
  paletteOpen: boolean;
  /**
   * Something the palette asked a session's view to open — a picker, a dialog,
   * or its title for renaming. The view takes it once.
   */
  request: { sessionId: string; kind: CommandSurface | 'rename' } | null;
}

export const useAppStore = create<AppState>(() => ({
  status: 'closed',
  info: null,
  workspaces: [],
  sessions: [],
  views: {},
  slash: {},
  skills: {},
  models: {},
  git: {},
  branches: {},
  gitRev: {},
  terminals: {},
  restored: {},
  error: null,
  archiveConflict: null,
  helpOpen: false,
  addProjectOpen: false,
  paletteOpen: false,
  request: null,
}));
