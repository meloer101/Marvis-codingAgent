/**
 * The set of MCP servers a run has configured.
 *
 * `toolSpecs()` connects every server (lazily, in parallel) and returns the
 * union of their tools, already namespaced. A server that fails to connect
 * contributes nothing and is reported through `status()` — it never makes the
 * whole call throw, so one broken server in `.mcp.json` cannot take the agent
 * down with it.
 */

import type { AnyToolSpec } from '../tools/types.js';
import { McpConnection } from './client.js';
import type { McpConnectionState, McpPrompt, McpResource } from './client.js';
import type { McpServerConfig } from './config.js';
import { adaptMcpTool } from './tool-adapter.js';

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  state: McpConnectionState;
  error?: string;
  toolCount: number;
}

/** What `reconfigure` did, by server name. */
export interface McpHubChanges {
  added: string[];
  removed: string[];
  /** Its entry changed: connected again with the new one. */
  changed: string[];
  /** Unchanged but it had failed: tried again (`retryFailed`). */
  retried: string[];
}

export class McpHub {
  private connections: McpConnection[];
  private readonly configByName = new Map<string, McpServerConfig>();
  private toolCache: AnyToolSpec[] | undefined;
  private readonly toolCountByName = new Map<string, number>();
  private readonly opts: { connectTimeoutMs?: number; callTimeoutMs?: number };

  constructor(
    configs: readonly McpServerConfig[],
    opts: { connectTimeoutMs?: number; callTimeoutMs?: number } = {},
  ) {
    this.opts = opts;
    this.connections = configs.map((c) => {
      this.configByName.set(c.name, c);
      return new McpConnection(c, opts);
    });
  }

  /**
   * Take up a new set of servers — the config files changed — keeping each
   * connection whose entry is the same, so a live session reconnects only
   * what changed. A server dropped or changed is closed; with `retryFailed`,
   * one that had failed is tried again (a sign-in may have fixed it). The
   * new ones connect on the next `toolSpecs()`.
   */
  async reconfigure(configs: readonly McpServerConfig[], opts: { retryFailed?: boolean } = {}): Promise<McpHubChanges> {
    const changes: McpHubChanges = { added: [], removed: [], changed: [], retried: [] };
    const old = new Map(this.connections.map((c) => [c.name, c]));
    const next: McpConnection[] = [];
    const closing: McpConnection[] = [];
    for (const config of configs) {
      const kept = old.get(config.name);
      old.delete(config.name);
      const same = kept !== undefined && JSON.stringify(this.configByName.get(config.name)) === JSON.stringify(config);
      if (kept && same && !(opts.retryFailed && kept.state === 'failed')) {
        next.push(kept);
        continue;
      }
      if (kept) {
        closing.push(kept);
        (same ? changes.retried : changes.changed).push(config.name);
      } else {
        changes.added.push(config.name);
      }
      this.toolCountByName.delete(config.name);
      next.push(new McpConnection(config, this.opts));
    }
    for (const gone of old.values()) {
      closing.push(gone);
      changes.removed.push(gone.name);
      this.toolCountByName.delete(gone.name);
    }
    this.connections = next;
    this.configByName.clear();
    for (const c of configs) this.configByName.set(c.name, c);
    if (closing.length > 0 || changes.added.length > 0) this.toolCache = undefined;
    await Promise.all(closing.map((c) => c.close()));
    return changes;
  }

  get empty(): boolean {
    return this.connections.length === 0;
  }

  /** Every server's tools, connecting on first call and caching the result. */
  async toolSpecs(): Promise<AnyToolSpec[]> {
    if (this.toolCache) return this.toolCache;
    const perServer = await Promise.all(
      this.connections.map(async (conn) => {
        const tools = await conn.listTools();
        this.toolCountByName.set(conn.name, tools.length);
        return tools.map((t) => adaptMcpTool(conn, t));
      }),
    );
    this.toolCache = perServer.flat();
    return this.toolCache;
  }

  async resources(): Promise<{ server: string; resource: McpResource }[]> {
    const perServer = await Promise.all(
      this.connections.map(async (conn) =>
        (await conn.listResources()).map((resource) => ({ server: conn.name, resource })),
      ),
    );
    return perServer.flat();
  }

  async prompts(): Promise<{ server: string; prompt: McpPrompt }[]> {
    const perServer = await Promise.all(
      this.connections.map(async (conn) =>
        (await conn.listPrompts()).map((prompt) => ({ server: conn.name, prompt })),
      ),
    );
    return perServer.flat();
  }

  connection(name: string): McpConnection | undefined {
    return this.connections.find((c) => c.name === name);
  }

  status(): McpServerStatus[] {
    return this.connections.map((c) => ({
      name: c.name,
      transport: this.configByName.get(c.name)?.transport ?? 'stdio',
      state: c.state,
      ...(c.error !== undefined ? { error: c.error } : {}),
      toolCount: this.toolCountByName.get(c.name) ?? 0,
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.close()));
    this.toolCache = undefined;
  }
}
