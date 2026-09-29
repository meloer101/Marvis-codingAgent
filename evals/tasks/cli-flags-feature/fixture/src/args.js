export const LEVELS = ['debug', 'info', 'warn', 'error'];

export const USAGE = `Usage: logq [options] <file>

Options:
  --level <level>  only events at this level or above (${LEVELS.join(', ')})
  --svc <name>     only events from this service
  -h, --help       show this help

<file> is a JSON-lines log; use - to read standard input.
`;

export class UsageError extends Error {}

function valueOf(argv, i, flag) {
  const value = argv[i];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return value;
}

export function parseArgs(argv) {
  const opts = { level: null, svc: null, file: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--level') {
      const level = valueOf(argv, ++i, arg);
      if (!LEVELS.includes(level)) throw new UsageError(`unknown level "${level}" (expected ${LEVELS.join(', ')})`);
      opts.level = level;
    } else if (arg === '--svc') {
      opts.svc = valueOf(argv, ++i, arg);
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
