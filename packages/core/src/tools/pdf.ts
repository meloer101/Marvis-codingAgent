/**
 * The text of a PDF's pages, for the `read` tool. pdf.js (unpdf's serverless
 * build, pure JS) is imported only when a PDF is actually read, so nothing
 * else pays for it — and a runtime too old for it fails that read, not the
 * session.
 */

/** Pages `read` returns from a PDF when it isn't given a range. */
export const PDF_DEFAULT_PAGES = 10;
/** Pages one `read` call returns at most. */
export const PDF_MAX_PAGES = 20;

/** A PDF starts with `%PDF-` whatever its name says. */
export function isPdf(head: Uint8Array): boolean {
  return head.length >= 5 && String.fromCharCode(...head.subarray(0, 5)) === '%PDF-';
}

export interface PageRange {
  first: number;
  last: number;
}

/**
 * `"3"` or `"1-5"` (`"12-"` runs to the end) against a document of `total`
 * pages, clipped to `PDF_MAX_PAGES`; a string saying what's wrong otherwise.
 */
export function parsePageRange(spec: string, total: number): PageRange | string {
  const m = /^\s*(\d+)\s*(?:(-)\s*(\d+)?)?\s*$/.exec(spec);
  if (!m) return `pages must look like "3" or "1-5", not "${spec}"`;
  const first = Number(m[1]);
  const last = m[2] ? (m[3] ? Number(m[3]) : total) : first;
  if (first < 1 || last < first) return `pages "${spec}" is not a range of pages`;
  if (first > total) return `the PDF has ${total} page${total === 1 ? '' : 's'}; pages "${spec}" starts past the end`;
  const end = Math.min(last, total);
  if (end - first + 1 > PDF_MAX_PAGES) return `at most ${PDF_MAX_PAGES} pages per read; ask for "${first}-${first + PDF_MAX_PAGES - 1}"`;
  return { first, last: end };
}

export interface PdfPages {
  totalPages: number;
  /** The pages asked for, in order. */
  pages: { number: number; text: string }[];
}

/**
 * Extract the text of `range` (or the first `PDF_DEFAULT_PAGES` pages),
 * a line per line of the page as pdf.js lays it out.
 */
export async function readPdfPages(data: Uint8Array, range?: (total: number) => PageRange | string): Promise<PdfPages | string> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(data);
  try {
    const totalPages = pdf.numPages;
    const wanted = range ? range(totalPages) : { first: 1, last: Math.min(totalPages, PDF_DEFAULT_PAGES) };
    if (typeof wanted === 'string') return wanted;
    const pages: PdfPages['pages'] = [];
    for (let n = wanted.first; n <= wanted.last; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      pages.push({ number: n, text: text.replace(/[ \t]+\n/g, '\n').trim() });
      page.cleanup();
    }
    return { totalPages, pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
