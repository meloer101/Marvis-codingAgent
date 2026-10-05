import { readFile, stat } from 'node:fs/promises';

import { z } from 'zod';

import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import { fmtBytes } from '../util/format.js';
import { PDF_DEFAULT_PAGES, PDF_MAX_PAGES, isPdf, parsePageRange, readPdfPages } from './pdf.js';
import type { ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  path: z.string().describe('File path to read, relative to the workspace root or absolute.'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start from.'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
  pages: z
    .string()
    .optional()
    .describe(`PDF only: the pages to read, like "3" or "1-5" (at most ${PDF_MAX_PAGES}). Without it, the first ${PDF_DEFAULT_PAGES}.`),
});

const DEFAULT_LIMIT = 2000;
/**
 * Per-line ceiling. A minified bundle or a JSONL log can be one line of many
 * megabytes; without this, `read` would pull the whole thing into context.
 */
const MAX_LINE_CHARS = 2000;

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)} … +${line.length - MAX_LINE_CHARS} chars on this line`;
}

export const readTool: ToolSpec<z.infer<typeof schema>> = {
  name: 'read',
  description:
    'Read a file from the workspace, with line numbers (like `cat -n`). Paginate long ' +
    'files with offset/limit instead of reading them all at once. A PDF comes back as the ' +
    'text of its pages — pass `pages` for a long one. Other binary files (images, Office ' +
    'documents, archives) are refused: inspect those with bash.',
  schema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx) {
    let path: string;
    try {
      path = await assertInsideWorkspace(ctx.cwd, input.path, { allowScratch: true });
    } catch (err) {
      const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
      return { content: message, isError: true };
    }
    let bytes: Buffer;
    let mtimeMs: number;
    try {
      const [content, stats] = await Promise.all([readFile(path), stat(path)]);
      bytes = content;
      mtimeMs = stats.mtimeMs;
    } catch (err) {
      return { content: `Could not read ${input.path}: ${errorMessage(err)}`, isError: true };
    }
    if (isPdf(bytes)) {
      const result = await readPdf(input.path, bytes, input.pages);
      if (!result.isError) ctx.session.markRead(path, mtimeMs);
      return result;
    }
    // A NUL in the first 8 KB: not text, whatever the extension says.
    if (bytes.subarray(0, 8192).includes(0)) {
      return {
        content:
          `${input.path} is a binary file (${fmtBytes(bytes.length)}); read only shows text and PDFs. ` +
          'Inspect it with bash instead — `file`, `unzip -l`, or on macOS `textutil -convert txt -stdout` for .docx/.rtf.',
        isError: true,
      };
    }
    const text = bytes.toString('utf8');
    ctx.session.markRead(path, mtimeMs);

    const lines = text.split('\n');
    const start = Math.max(0, (input.offset ?? 1) - 1);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(start, start + limit);
    const rendered = slice
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${clampLine(line)}`)
      .join('\n');
    const omitted = lines.length - (start + slice.length);
    const suffix =
      omitted > 0
        ? `\n... ${omitted} more line(s); pass offset ${start + slice.length + 1} to continue.`
        : '';
    return { content: rendered + suffix };
  },
};

/** A PDF's pages as text, each under a `--- Page N ---` line, and where to go on from. */
async function readPdf(
  shown: string,
  bytes: Buffer,
  pages: string | undefined,
): Promise<{ content: string; isError?: true }> {
  let read: Awaited<ReturnType<typeof readPdfPages>>;
  try {
    read = await readPdfPages(new Uint8Array(bytes), pages === undefined ? undefined : (total) => parsePageRange(pages, total));
  } catch (err) {
    return { content: `Could not read ${shown} as a PDF: ${errorMessage(err)}`, isError: true };
  }
  if (typeof read === 'string') return { content: `Can't read ${shown}: ${read}`, isError: true };
  const { totalPages } = read;
  const body = read.pages
    .map((p) => `--- Page ${p.number} ---\n${p.text ? p.text.split('\n').map(clampLine).join('\n') : '(no text on this page)'}`)
    .join('\n\n');
  const notes = [`PDF, ${totalPages} page${totalPages === 1 ? '' : 's'}.`];
  const last = read.pages.at(-1)?.number ?? 0;
  if (last < totalPages) {
    const next = `${last + 1}-${Math.min(totalPages, last + PDF_MAX_PAGES)}`;
    notes.push(`... ${totalPages - last} more page(s); pass pages "${next}" to continue.`);
  }
  if (read.pages.every((p) => !p.text)) {
    notes.push('No text layer on these pages — likely scanned images; OCR them with bash if a tool is installed.');
  }
  return { content: `${notes[0]}\n\n${body}${notes.length > 1 ? `\n\n${notes.slice(1).join('\n')}` : ''}` };
}
