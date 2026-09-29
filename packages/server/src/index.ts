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
} from '@harness-code/core';
import type { PermissionMode } from '@harness-code/core';
import type { ServerInfo } from '@harness-code/protocol';

import { createStaticHandler, resolveStaticDir } from './http.js';
import type { HealthInfo } from './instance.js';
import { MOCK_MODEL_REF, mockConfigFactory } from './mock.js';
import { SessionRegistry } from './registry.js';
import type { SessionConfigFactory } from './registry.js';
import { attachWsServer } from './ws.js';

const PERMISSION_MODES: PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo', 'auto'];

export interface StartServerOptions {
  /** Workspace root this server hosts sessions for. */
  cwd: string;
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
  const { cwd } = opts;
  const projectRoot = await findProjectRoot(cwd);
  const token = opts.token ?? randomBytes(32).toString('hex');
  const bootId = randomUUID();

  // `--mock` sessions record into a throwaway dir (removed on close) so a demo
  // never touches the project's real `.agent/` — see `mockConfigFactory`.
  const mockDir = opts.mock && !opts.buildConfig ? await mkdtemp(join(tmpdir(), 'hc-web-mock-')) : undefined;
  const agentDir = mockDir ?? (await resolveStateDir(cwd));

  const buildConfig = resolveConfigFactory(opts, mockDir);

  const serverInfo = async (): Promise<ServerInfo> => {
    const { settings } = await loadSettings(cwd);
    const providers = new ProviderRegistry({ settings });
    return {
      version: VERSION,
      bootId,
      cwd,
      projectRoot,
      // A mock server's sessions all run the scripted model, whatever settings say.
      defaultModel: opts.mock && !opts.buildConfig ? MOCK_MODEL_REF : (opts.model ?? settings.model ?? ''),
      defaultMode: settings.permissions?.mode ?? 'ask',
      models: providers.list(),
      modes: PERMISSION_MODES.filter(
        (m) =>
          m !== 'auto' ||
          isAutoModeAvailable(settings, providers, opts.model ?? settings.model).available,
      ),
    };
  };

  const registry = new SessionRegistry({
    cwd,
    agentDir,
    buildConfig,
    previewDefaults: async () => {
      const info = await serverInfo();
      return { modelRef: info.defaultModel, mode: info.defaultMode };
    },
  });

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
    await registry.shutdown();
    if (mockDir) await rm(mockDir, { recursive: true, force: true });
    throw err;
  }
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (opts.devOrigin) origins.add(opts.devOrigin);
  hosts.add(`127.0.0.1:${port}`);
  hosts.add(`localhost:${port}`);

  const wss = attachWsServer({
    httpServer,
    registry,
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
      await registry.shutdown();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      if (mockDir) await rm(mockDir, { recursive: true, force: true });
    },
  };
}

/** Pick the session factory: explicit injection > `--mock` > the real config assembly. */
function resolveConfigFactory(opts: StartServerOptions, mockDir?: string): SessionConfigFactory {
  if (opts.buildConfig) return opts.buildConfig;
  if (opts.mock) return mockConfigFactory(opts.cwd, mockDir);
  return (o) =>
    buildSessionConfig({
      cwd: opts.cwd,
      ...(o.model ?? opts.model ? { modelRef: o.model ?? opts.model } : {}),
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.effort ? { reasoningEffort: o.effort } : {}),
      ...(o.resumeId ? { resumeId: o.resumeId } : {}),
    });
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
