import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/** A titled block of settings: a light grey zone, with what can be acted on in it white. */
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
    <section aria-label={label} className={cn('@container rounded-lg bg-subtle p-4', className)}>
      <div className="mb-3.5 flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
          {aside}
        </div>
        {path && <PathNote path={path} />}
      </div>
      {children}
    </section>
  );
}

/** A section's title (20, the one size step) and what it is for. */
export function SectionIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-xl leading-[26px] font-semibold">{title}</h1>
      <p className="text-[13px] leading-[1.4] text-muted-foreground">{children}</p>
    </div>
  );
}

/** A rule or a name inside prose. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[11px] text-foreground">{children}</code>;
}

/** A file's path, quiet and mono — cut from the left when long: the end says which file. */
export function PathNote({ path }: { path: string }) {
  return (
    <span className="min-w-0 truncate text-left font-mono text-[11px] text-faint [direction:rtl]" title={path}>
      <span dir="ltr">{path}</span>
    </span>
  );
}

/** Files that couldn't be read: named, outlined as errors are, above what was. */
export function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
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
      <ul aria-label={label} className="flex flex-col gap-1 empty:hidden">
          {rules.map((rule, i) => (
            <li key={`${i}:${rule}`} className="group/rule flex items-start gap-2 rounded-md bg-background px-2 py-1">
              <span className="min-w-0 flex-1 font-mono text-xs leading-[1.55] break-words">{render ? render(rule, i) : rule}</span>
              <button
                type="button"
                aria-label={`Remove ${rule}`}
                title="Remove"
                disabled={busy}
                onClick={() => void change(rules.filter((_, j) => j !== i))}
                className="mt-0.5 rounded p-px text-muted-foreground opacity-0 transition-opacity group-hover/rule:opacity-100 hover:text-destructive focus-visible:opacity-100"
              >
                <X className="size-[13px]" />
              </button>
            </li>
          ))}
      </ul>
      <form
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2 transition-colors focus-within:bg-background',
          error && 'border border-destructive bg-background',
        )}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Plus className="size-[13px] shrink-0 text-faint" />
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
          className="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint"
        />
      </form>
      <ErrorLine error={error} />
    </div>
  );
}
