export const LEVELS = ['debug', 'info', 'warn', 'error'];

export const USAGE = `Usage: logq [options] <file>

Options:
  --level <level>  only events at this level or above (${LEVELS.join(', ')})
  --svc <name>     only events from this service
  --since <time>   only events at or after <time>: 2026-09-01 (UTC midnight),
                   2026-09-01T10:00:00Z, or relative to now: 30m, 2h, 7d
  --json           print each event as one line of JSON instead of a table
  -h, --help       show this help

<file> is a JSON-lines log; use - to read standard input.
`;

export class UsageError extends Error {}

const RELATIVE = /^(\d+)([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

export function parseSince(value, now) {
  const relative = RELATIVE.exec(value);
  if (relative) return new Date(now.getTime() - Number(relative[1]) * UNIT_MS[relative[2]]);
  // A bare date is UTC midnight, like the timestamps in the log.
  const iso = DATE_ONLY.test(value) ? `${value}T00:00:00Z` : DATE_TIME.test(value) ? value : null;
  const date = iso === null ? null : new Date(iso);
  if (date === null || Number.isNaN(date.getTime())) {
    throw new UsageError(`invalid --since "${value}" (expected 2026-09-01, 2026-09-01T10:00:00Z, 30m, 2h or 7d)`);
  }
  return date;
}

function valueOf(argv, i, flag) {
  const value = argv[i];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return value;
}

export function parseArgs(argv, { now = new Date() } = {}) {
  const opts = { level: null, svc: null, since: null, json: false, file: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--level') {
      const level = valueOf(argv, ++i, arg);
      if (!LEVELS.includes(level)) throw new UsageError(`unknown level "${level}" (expected ${LEVELS.join(', ')})`);
      opts.level = level;
    } else if (arg === '--svc') {
      opts.svc = valueOf(argv, ++i, arg);
    } else if (arg === '--since') {
      opts.since = parseSince(valueOf(argv, ++i, arg), now);
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`unknown option ${arg}`);
    } else if (opts.file === null) {
      opts.file = arg;
    } else {
      throw new UsageError(`unexpected argument ${arg}`);
    }
  }
  if (!opts.help && opts.file === null) throw new UsageError('missing <file>');
  return opts;
}
