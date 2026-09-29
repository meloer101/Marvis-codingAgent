/**
 * `startServer` — the local `hc web` host: a `node:http` server that serves the
 * SPA bundle and upgrades `/ws` to the RPC + event socket. It binds `127.0.0.1`
 * only and authenticates with the token it is given (`hc web` passes the one it
 * keeps in `~/.agent/web`) or a fresh random one; the token rides the URL
 * fragment so it never lands in logs (docs/web.md, "Security").
 *
 * The public surface is intentionally tiny: `startServer(opts)` →
 * `{ url, token, port, bootId, close }`. Everything else (the registry, the WS
 * layer, static serving) is wired here so the CLI and tests share one entry
 * point.
 */

import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveStateDir,
  ProviderRegistry,
  VERSION,
  buildSessionConfig,
  findProjectRoot,
  isAutoModeAvailable,
  loadSettings,
  modelEffort,
  projectEnv,
} from '@harness-code/core';
import type { PermissionMode } from '@harness-code/core';
import type { ServerInfo, WorkspaceDefaults } from '@harness-code/protocol';

import { createStaticHandler, resolveStaticDir } from './http.js';
import { WorkspaceHub } from './hub.js';
import type { WorkspaceSetupFactory } from './hub.js';
import type { HealthInfo } from './instance.js';
import { MOCK_MODEL_REF, mockConfigFactory, mockEffortOptions } from './mock.js';
import type { SessionConfigFactory } from './registry.js';
import { memoryWorkspaceStore } from './workspaces.js';
import type { WorkspaceStore } from './workspaces.js';
import { attachWsServer } from './ws.js';

const PERMISSION_MODES: PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo', 'auto'];

export interface StartServerOptions {
  /** The workspace it starts with (added to the remembered ones, and made the most recent). */
  cwd: string;
  /**
   * Where the hosted workspaces are remembered; in memory (forgotten on close)
   * when omitted. `hc web` passes `~/.agent/web/workspaces.json`.
   */
  workspaceStore?: WorkspaceStore;
  /** TCP port; `0` (the default) picks a free one. */
  port?: number;
  /** An extra `Origin` to allow through the WS handshake — the Vite dev server. */
  devOrigin?: string;
  /** Default `provider/model` ref for new sessions (overrides `settings.model`). */
  model?: string;
  /** Replace the real model with the scripted `--mock` provider. */
  mock?: boolean;
  /** Inject a session-config factory directly (tests). Wins over `mock`/`model`. */
  buildConfig?: SessionConfigFactory;
  /** Override the static bundle directory (tests / non-standard layouts). */
  staticDir?: string;
  /** The auth token; a fresh random one when omitted. `hc web` passes the persisted one. */
  token?: string;
}

export interface RunningServer {
  /** `http://127.0.0.1:<port>/#token=<token>` — open this in a browser. */
  url: string;
  token: string;
  port: number;
  /** New every start (`ServerInfo.bootId`, the health endpoint). */
  bootId: string;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(32).toString('hex');
  const bootId = randomUUID();

  const hub = new WorkspaceHub({ store: opts.workspaceStore ?? memoryWorkspaceStore(), setup: workspaceSetups(opts) });
  const launchId = await hub.init(opts.cwd);

  /** Kept for older clients: the launch workspace's defaults. */
  const serverInfo = async (): Promise<ServerInfo> => {
    const launch = await hub.workspace(launchId);
    return {
      version: VERSION,
      bootId,
      cwd: launch.root,
      projectRoot: launch.projectRoot,
      defaultModel: launch.defaults.model,
      defaultMode: launch.defaults.mode,
      models: [],
      modes: launch.defaults.modes,
    };
  };

  const staticDir = opts.staticDir ?? resolveStaticDir();
  // Filled in once the port is known; the handler checks every request against it.
  const hosts = new Set<string>();
  const health = (): HealthInfo => ({ app: 'hc-web', version: VERSION, bootId, pid: process.pid });
  const httpServer = createServer(
    createStaticHandler({ ...(staticDir ? { staticDir } : {}), allowedHosts: hosts, health }),
  );

  let port: number;
  try {
    port = await listen(httpServer, opts.port ?? 0);
  } catch (err) {
    // Typically EADDRINUSE: undo what was set up so the caller can retry elsewhere.
    await hub.shutdown();
    throw err;
  }
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (opts.devOrigin) origins.add(opts.devOrigin);
  hosts.add(`127.0.0.1:${port}`);
  hosts.add(`localhost:${port}`);

  const wss = attachWsServer({
    httpServer,
    hub,
    token,
    allowedOrigins: origins,
    allowedHosts: hosts,
    serverInfo,
  });

  const url = `http://127.0.0.1:${port}/#token=${token}`;

  return {
    url,
    token,
    port,
    bootId,
    close: async () => {
      // Terminate live sockets first, otherwise `httpServer.close` waits for
      // every open connection to drain and never resolves.
      for (const client of wss.clients) client.terminate();
      wss.close();
      await hub.shutdown();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * How each workspace is set up: explicit injection (tests) > `--mock` > the
 * real config assembly. Every workspace gets its own environment — the real
 * one, its `.env`, `~/.agent/.env` — for provider keys and MCP `${VAR}`s,
 * never merged into `process.env`.
 */
function workspaceSetups(opts: StartServerOptions): WorkspaceSetupFactory {
  const mock = opts.mock === true && !opts.buildConfig;
  return async (root) => {
    const env = projectEnv(root);
    const projectRoot = await findProjectRoot(root);
    // `--mock` sessions record into a throwaway dir (removed on close) so a
    // demo never touches the project's real `.agent/` — see `mockConfigFactory`.
    const mockDir = mock ? await mkdtemp(join(tmpdir(), 'hc-web-mock-')) : undefined;
    const agentDir = mockDir ?? (await resolveStateDir(root, { env }));

    const defaults = async (): Promise<WorkspaceDefaults> => {
      if (mock) {
        // The scripted model reasons, but has no classifier behind it: no auto mode.
        const { levels, initial } = mockEffortOptions();
        return {
          model: MOCK_MODEL_REF,
          mode: 'ask',
          modes: PERMISSION_MODES.filter((m) => m !== 'auto'),
          effortLevels: [...levels],
          ...(initial ? { effort: initial } : {}),
        };
      }
      const { settings } = await loadSettings(root);
      const providers = new ProviderRegistry({ settings, env });
      const model = opts.model ?? settings.model ?? '';
      const { levels, initial } = model ? modelEffort(model, settings) : { levels: [], initial: undefined };
      let keyProblem: string | undefined;
      try {
        if (model) providers.resolve(model); // no network: only whether it could be used
      } catch (err) {
        keyProblem = err instanceof Error ? err.message : String(err);
      }
      return {
        model,
        mode: settings.permissions?.mode ?? 'ask',
        modes: PERMISSION_MODES.filter(
          (m) => m !== 'auto' || isAutoModeAvailable(settings, providers, model || undefined).available,
        ),
        effortLevels: [...levels],
        ...(initial ? { effort: initial } : {}),
        ...(keyProblem ? { keyProblem } : {}),
      };
    };

    const buildConfig: SessionConfigFactory =
      opts.buildConfig ??
      (mock
        ? mockConfigFactory(root, mockDir)
        : (o) =>
            buildSessionConfig({
              cwd: root,
              env,
              ...(o.model ?? opts.model ? { modelRef: o.model ?? opts.model } : {}),
              ...(o.mode ? { mode: o.mode } : {}),
              ...(o.effort ? { reasoningEffort: o.effort } : {}),
              ...(o.resumeId ? { resumeId: o.resumeId } : {}),
            }));

    return {
      projectRoot,
      agentDir,
      buildConfig,
      defaults,
      previewDefaults: async () => {
        const d = await defaults();
        return { modelRef: d.model, mode: d.mode };
      },
      effortFor: mock ? () => mockEffortOptions() : async (ref) => modelEffort(ref, (await loadSettings(root)).settings),
      ...(mockDir ? { dispose: () => rm(mockDir, { recursive: true, force: true }) } : {}),
    };
  };
}

/** Bind `127.0.0.1` only and resolve with the actual port (handles `port: 0`). */
function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server address is not a TCP address'));
    });
  });
}

export { SessionRegistry } from './registry.js';
export { WorkspaceHub, WorkspaceNotFoundError } from './hub.js';
export type { WorkspaceSetup, WorkspaceSetupFactory } from './hub.js';
export { fileWorkspaceStore, memoryWorkspaceStore, workspaceId, workspacesFile } from './workspaces.js';
export type { WorkspaceRecord, WorkspaceStore } from './workspaces.js';
export { SessionHost, BusyError, SessionNotFoundError } from './host.js';
export type { Listener } from './host.js';
export { attachWsServer } from './ws.js';
export type { WsServerOptions } from './ws.js';
export { createStaticHandler, resolveStaticDir } from './http.js';
export { mockConfigFactory } from './mock.js';
export {
  clearInstance,
  findRunningInstance,
  loadOrCreateToken,
  rotateToken,
  webStateDir,
  writeInstance,
} from './instance.js';
export type { HealthInfo, InstanceRecord } from './instance.js';
export type { SessionConfigFactory, SessionRegistryOptions } from './registry.js';
