/**
 * Connectors offered by name on the settings page: one click adds the server
 * to `~/.agent/.mcp.json` and, for one that signs in, opens the browser.
 *
 * Only servers checked against what Marvis does: the ones without a sign-in
 * connected and listed their tools; the ones with one advertise OAuth
 * dynamic client registration, which `mcp.login` needs. Hosted servers that
 * admit only clients on a list of their own (Figma's, for one) stay out —
 * added, they would fail at the sign-in. Checked 2026-10-05.
 */

export interface CatalogConnector {
  /** Its name in `.mcp.json`, and so in its tools' names (`mcp__<id>__…`). */
  id: string;
  name: string;
  description: string;
  url: string;
  transport: 'http' | 'sse';
  /** Signs in with OAuth: the browser opens once it's added. */
  signIn: boolean;
  /** The tile's colour. */
  color: string;
  /** What to check when it can't be reached. */
  hint?: string;
}

export const CATALOG: readonly CatalogConnector[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and update pages in your workspace',
    url: 'https://mcp.notion.com/mcp',
    transport: 'http',
    signIn: true,
    color: '#191919',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Find, create and update issues and projects',
    url: 'https://mcp.linear.app/mcp',
    transport: 'http',
    signIn: true,
    color: '#5e6ad2',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Look into errors and performance issues',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'http',
    signIn: true,
    color: '#362d59',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read the designs open in the Figma desktop app — it can’t edit them',
    url: 'http://127.0.0.1:3845/mcp',
    transport: 'http',
    signIn: false,
    color: '#f24e1e',
    hint: 'Open a design in the Figma desktop app, switch to Dev Mode (Shift+D) and click “Enable desktop MCP server” in the inspect panel, then check again.',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Current docs and examples for the libraries you use',
    url: 'https://mcp.context7.com/mcp',
    transport: 'http',
    signIn: false,
    color: '#0f766e',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: 'Ask about any public GitHub repository',
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'http',
    signIn: false,
    color: '#2563eb',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Search models, datasets, papers and Spaces',
    url: 'https://huggingface.co/mcp',
    transport: 'http',
    signIn: false,
    color: '#d97706',
  },
];

/** A URL as two spellings of it compare: no trailing slash, host in lower case. */
function normalUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim();
  }
}

/**
 * What to do instead, for hosted servers known to turn Marvis away at
 * their sign-in (they admit only the apps they list).
 */
const TURNED_AWAY: Readonly<Record<string, string>> = {
  'https://mcp.figma.com/mcp':
    'Figma’s hosted server admits only the apps Figma lists. To read designs, add Figma from Discover — it goes through the Figma desktop app.',
};

/** What to check, or do instead, when the server at `target` can't be reached. */
export function connectorHint(target: string): string | undefined {
  return catalogAt(target)?.hint ?? TURNED_AWAY[normalUrl(target)];
}

/** The catalog's connector at `target` (a server's URL as its file has it). */
export function catalogAt(target: string): CatalogConnector | undefined {
  const t = normalUrl(target);
  return CATALOG.find((c) => normalUrl(c.url) === t);
}

/**
 * The name a connector added by URL gets in `.mcp.json`: what was typed,
 * made one of the names a file can hold (letters, digits, `-`, `_`) — or,
 * when nothing of it is left ("飞书"), the URL's host without its `mcp.` or
 * `www.`. Undefined when the URL isn't one.
 */
export function connectorName(typed: string, url: string): string | undefined {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  const named = slug(typed);
  if (named !== '') return named;
  let host: string;
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    return undefined;
  }
  const labels = host.split('.').filter((l) => l !== 'mcp' && l !== 'www' && l !== 'api');
  return slug(labels.length > 1 ? labels.slice(0, -1).join('-') : (labels[0] ?? host)) || undefined;
}

/** `http` or `sse` for a URL typed in: SSE when it ends in `/sse`, as `.mcp.json` infers it. */
export function transportOf(url: string): 'http' | 'sse' {
  return /\/sse\/?(?:$|\?)/.test(url.trim()) ? 'sse' : 'http';
}
