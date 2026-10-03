import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import { MAX_DISPLAY_BEFORE_BYTES } from './types.js';
import type { ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  path: z.string().describe('File path to write, relative to the workspace root or absolute.'),
  content: z.string().describe('Full contents to write.'),
});

export const writeTool: ToolSpec<z.infer<typeof schema>> = {
  name: 'write',
  description:
    'Write a file, creating it or overwriting it entirely. An existing file must have been ' +
    'read in this session first, so you know what you are replacing.',
  schema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx) {
    let path: string;
    try {
      path = await assertInsideWorkspace(ctx.cwd, input.path, { allowScratch: true });
    } catch (err) {
      const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
      return { content: message, isError: true };
    }
    const existing = await stat(path).catch(() => undefined);
    const existingMtimeMs = existing?.mtimeMs;
    if (existingMtimeMs !== undefined && !ctx.session.hasRead(path)) {
      return {
        content: `Refusing to overwrite ${input.path}: read it first so you know what you are replacing.`,
        isError: true,
      };
    }

    const readMtimeMs = ctx.session.readMtime(path);
    if (existingMtimeMs !== undefined && readMtimeMs !== undefined && existingMtimeMs !== readMtimeMs) {
      return {
        content: `${input.path} changed on disk since you read it — read it again before overwriting.`,
        isError: true,
      };
    }

    // What it replaces, for a frontend to diff against (never the model's to see).
    const before =
      existing?.isFile() && existing.size <= MAX_DISPLAY_BEFORE_BYTES
        ? await readFile(path).then(
            (buf) => (buf.subarray(0, 8192).includes(0) ? undefined : buf.toString('utf8')),
            () => undefined,
          )
        : undefined;

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content, 'utf8');
    } catch (err) {
      return { content: `Could not write ${input.path}: ${errorMessage(err)}`, isError: true };
    }

    const stats = await stat(path);
    ctx.session.markRead(path, stats.mtimeMs);
    return {
      content: `Wrote ${input.content.length} bytes to ${input.path}`,
      ...(before !== undefined ? { display: { before } } : {}),
    };
  },
};
