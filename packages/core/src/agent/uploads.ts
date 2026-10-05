/**
 * Files the user uploads with a message (dropped, pasted or picked in the web
 * composer — from anywhere on their machine, not just the workspace). Each is
 * saved under the system temp directory (`uploadsRoot`), which the file tools
 * already reach (`allowScratch`) and may read there in any mode, in a folder
 * of its own so two uploads of `notes.txt` don't collide; the message then
 * carries its path like any attached file. Like any temp file it lasts while
 * the system keeps it (macOS clears what's untouched for days) — what the
 * message inlined stays in the session either way.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { uploadsRoot } from '../permissions/paths.js';

/** What one upload may weigh (decoded). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A file name safe to write: no folders, no control characters, not empty or a dot name. */
export function safeUploadName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/:]/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

export interface SavedUpload {
  /** Absolute: what the message attaches. */
  path: string;
  name: string;
  size: number;
}

/** Save an upload and say where it went. */
export async function saveUpload(name: string, bytes: Uint8Array): Promise<SavedUpload> {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`${name} is ${Math.round(bytes.length / 1024 / 1024)} MB; ${MAX_UPLOAD_BYTES / 1024 / 1024} MB at most`);
  }
  const dir = join(await uploadsRoot(), randomUUID());
  await mkdir(dir, { recursive: true });
  const safe = safeUploadName(name);
  const path = join(dir, safe);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, name: safe, size: bytes.length };
}
