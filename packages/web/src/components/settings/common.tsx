import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, Trash2, TriangleAlert, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
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

/** A one-line field inside a white block: grey, mono, ringed on focus. */
export const FIELD =
  'h-7 min-w-0 rounded-md bg-subtle px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60';

/** A small label over a field, and what it holds. */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
        {hint && <span className="font-normal text-faint"> · {hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** One of a few choices, as a grey track with the chosen one white. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit max-w-full rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={cn(
            'truncate rounded-[3px] px-2.5 py-[3px] text-xs transition-colors disabled:opacity-60',
            value === o.id ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ARM_MS = 4000;

/**
 * Delete, armed first: a second click within a few seconds confirms. What
 * `onDelete` rejects with is shown beside it.
 */
export function DeleteButton({ name, onDelete }: { name: string; onDelete: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <>
      {error && (
        <span className="max-w-60 truncate text-[11px] text-destructive" title={error}>
          {error}
        </span>
      )}
      <button
        type="button"
        aria-label={armed ? `Confirm deleting ${name}` : `Delete ${name}`}
        title={armed ? 'Click again to delete' : 'Delete'}
        onClick={() => {
          if (!armed) return setArmed(true);
          setArmed(false);
          onDelete().then(
            () => setError(null),
            (err: unknown) => setError(errorText(err)),
          );
        }}
        className={cn(
          'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
          armed ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:text-destructive',
        )}
      >
        <Trash2 className="size-3" />
        {armed && 'Delete?'}
      </button>
    </>
  );
}

/**
 * A file's text in a mono field, read when it opens (again when `loadKey`
 * changes); Save writes it back, ⌘↵ too, and Escape cancels. `readOnly`
 * shows it with only a Close.
 */
export function FileEditor({
  load,
  loadKey,
  onSave,
  onCancel,
  readOnly,
  note,
}: {
  load: () => Promise<string>;
  loadKey: string;
  onSave?: (text: string) => Promise<void>;
  onCancel: () => void;
  readOnly?: boolean;
  /** A quiet line beside the buttons. */
  note?: ReactNode;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (t) => !cancelled && setText(t),
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [loadKey]);
  const save = async (): Promise<void> => {
    if (text === null || readOnly || !onSave) return;
    setSaving(true);
    try {
      await onSave(text);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md bg-background p-2">
      <textarea
        aria-label="File text"
        value={text ?? ''}
        disabled={text === null}
        readOnly={readOnly}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Escape') onCancel();
        }}
        rows={Math.min(24, Math.max(8, (text ?? '').split('\n').length + 1))}
        placeholder={text === null ? 'Reading…' : undefined}
        spellCheck={false}
        className="w-full resize-y rounded-md bg-subtle p-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <div className="flex items-center gap-2">
        <ErrorLine error={error} />
        {!error && note && <span className="text-[11px] text-faint">{note}</span>}
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onCancel}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!readOnly && (
          <Button size="xs" onClick={() => void save()} disabled={text === null || saving}>
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
