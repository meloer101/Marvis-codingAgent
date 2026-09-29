import { mapLimit } from './pool.js';

const CONCURRENCY = 4;

/**
 * Fetch one page. Non-2xx responses are errors.
 * @param {string} url
 */
export async function fetchPage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, body: await res.text() };
}

/**
 * Fetch every url, at most CONCURRENCY at a time, and pair each url with its
 * outcome. One failing page doesn't stop the others.
 *
 * @param {string[]} urls
 * @param {{ fetchPage?: (url: string) => Promise<{ status: number, body: string }> }} [options]
 */
export async function crawl(urls, { fetchPage: get = fetchPage } = {}) {
  const outcomes = await mapLimit(urls, CONCURRENCY, get, { settle: true });
  return urls.map((url, i) => {
    const outcome = outcomes[i];
    return outcome.status === 'fulfilled'
      ? { url, ok: true, status: outcome.value.status, bytes: outcome.value.body.length }
      : { url, ok: false, error: String(outcome.reason?.message ?? outcome.reason) };
  });
}
