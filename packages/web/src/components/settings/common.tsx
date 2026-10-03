import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/** A titled card, as the usage page's. */
export function Card({
  title,
  aside,
  path,
  children,
  className,
  label,
}: {
  title: ReactNode;
  aside?: ReactNode;
  /** The file it shows, on a quiet line under the title. */
  path?: string;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <section aria-label={label} className={cn('@container rounded-lg border bg-card p-4 shadow-xs', className)}>
      <div className="mb-3 flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-medium">{title}</h2>
          {aside}
        </div>
        {path && <PathNote path={path} />}
      </div>
      {children}
    </section>
  );
}

/** A file's path, quiet and mono — cut from the left when long: the end says which file. */
export function PathNote({ path }: { path: string }) {
  return (
    <span className="min-w-0 truncate text-left font-mono text-[11px] text-muted-foreground [direction:rtl]" title={path}>
      <span dir="ltr">{path}</span>
    </span>
  );
}

/** Files that couldn't be read: named, in brass, above what was. */
export function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-brass/30 bg-brass-subtle px-3 py-2 text-xs text-brass-strong">
      {problems.map((p) => (
        <p key={p} className="flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{p}</span>
        </p>
      ))}
    </div>
  );
}

/** What went wrong with the last thing asked, in the destructive colour. */
export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-xs text-destructive">{error}</p> : null;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Something read from the server for a section, again whenever `key`
 * changes; `set` puts in what a write answered with.
 */
export function useLoaded<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [key, rev]);
  const reload = useCallback(() => setRev((r) => r + 1), []);
  return { data, error, set: setData, reload };
}

/**
 * An editable list of rules, each a mono line with a remove button, and a
 * field that adds one on Enter. `onChange` gets the whole new list; what it
 * throws is shown under the field.
 */
export function RuleList({
  label,
  rules,
  placeholder,
  onChange,
  render,
}: {
  label: string;
  rules: readonly string[];
  placeholder: string;
  onChange: (next: string[]) => Promise<void>;
  /** How a rule shows, when not as itself. */
  render?: (rule: string, index: number) => ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async (next: string[]): Promise<boolean> => {
    setBusy(true);
    try {
      await onChange(next);
      setError(null);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (): Promise<void> => {
    const rule = draft.trim();
    if (!rule) return;
    if (await change([...rules, rule])) setDraft('');
  };
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label={label} className="flex flex-col">
        {rules.map((rule, i) => (
          <li key={`${i}:${rule}`} className="group/rule flex items-start gap-2 rounded px-1.5 py-1 hover:bg-accent/50">
            <span className="min-w-0 flex-1 font-mono text-xs break-words">{render ? render(rule, i) : rule}</span>
            <button
              type="button"
              aria-label={`Remove ${rule}`}
              title="Remove"
              disabled={busy}
              onClick={() => void change(rules.filter((_, j) => j !== i))}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/rule:opacity-100 hover:text-destructive focus-visible:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-1.5 px-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Plus className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds, as everywhere else here — not mid-composition (IME).
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void add();
          }}
          placeholder={placeholder}
          aria-label={`Add to ${label}`}
          disabled={busy}
          className="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
      </form>
      <div className="px-1.5">
        <ErrorLine error={error} />
      </div>
    </div>
  );
}
