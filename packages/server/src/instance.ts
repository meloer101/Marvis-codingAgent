/**
 * The long-lived side of `hc web`: a token that survives restarts and a record
 * of the running server, both under `~/.agent/web/`.
 *
 *  - **Token.** One per user, in `token` (0600, directory 0700), so a bookmark
 *    or an open tab keeps working when the server restarts. It is as powerful
 *    as the user's shell (a client can switch a session to yolo), so it never
 *    leaves this directory except in the URL `hc web` prints; `rotateToken`
 *    replaces it.
 *  - **Instance.** `server.json` records the running server's pid, port and
 *    boot id; `findRunningInstance` checks the pid and asks the server's
 *    `/__hc/health` endpoint before trusting it, so a stale file from a crash
 *    is ignored.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_FILE = 'token';
const INSTANCE_FILE = 'server.json';
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** `~/.agent/web` — `home` is injectable for tests. */
export function webStateDir(home: string = homedir()): string {
  return join(home, '.agent', 'web');
}

/** Create `dir` (and parents) private to the user. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {
    // Not ours to fix (e.g. Windows): the file itself is still 0600.
  });
}

/** Write `content` to `path` atomically (temp file + rename), readable by the user only. */
export async function writePrivate(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/** The persisted token, creating one on first use. */
export async function loadOrCreateToken(dir: string): Promise<string> {
  try {
    const token = (await readFile(join(dir, TOKEN_FILE), 'utf8')).trim();
    if (TOKEN_RE.test(token)) return token;
  } catch {
    // None yet.
  }
  return rotateToken(dir);
}

/** Replace the persisted token; every page holding the old one must reopen the printed URL. */
export async function rotateToken(dir: string): Promise<string> {
  await ensureDir(dir);
  const token = randomBytes(32).toString('hex');
  await writePrivate(join(dir, TOKEN_FILE), `${token}\n`);
  return token;
}

/** What `server.json` records about the running server. */
export interface InstanceRecord {
  pid: number;
  port: number;
  version: string;
  bootId: string;
  /** The workspace it serves. */
  cwd: string;
  startedAt: number;
}

export async function writeInstance(dir: string, record: InstanceRecord): Promise<void> {
  await ensureDir(dir);
  await writePrivate(join(dir, INSTANCE_FILE), `${JSON.stringify(record)}\n`);
}

/** Remove `server.json` if it still describes `pid` (a newer server may have replaced it). */
export async function clearInstance(dir: string, pid: number): Promise<void> {
  const record = await readInstance(dir);
  if (record?.pid === pid) await rm(join(dir, INSTANCE_FILE), { force: true });
}

async function readInstance(dir: string): Promise<InstanceRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, INSTANCE_FILE), 'utf8')) as Partial<InstanceRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number' || typeof parsed.bootId !== 'string') {
      return null;
    }
    return parsed as InstanceRecord;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The `/__hc/health` payload — nothing secret. */
export interface HealthInfo {
  app: 'hc-web';
  version: string;
  bootId: string;
  pid: number;
}

/**
 * The server `server.json` describes, if it is really up: its process is
 * alive and its health endpoint answers with the recorded boot id.
 */
export async function findRunningInstance(dir: string, timeoutMs = 800): Promise<InstanceRecord | null> {
  const record = await readInstance(dir);
  if (!record || !alive(record.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${record.port}/__hc/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const health = (await res.json()) as Partial<HealthInfo>;
    return health.app === 'hc-web' && health.bootId === record.bootId ? record : null;
  } catch {
    return null;
  }
}
