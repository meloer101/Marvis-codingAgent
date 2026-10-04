import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A field for an API key: typed hidden, saved on Enter or the button, and
 * gone from the page once saved — it is never shown again. `onSave` rejects
 * with why it couldn't be saved; that goes under the field.
 */
export function KeyField({
  label,
  onSave,
  onCancel,
  autoFocus,
  className,
}: {
  /** Whose key: "DeepSeek". */
  label: string;
  onSave: (key: string) => Promise<void>;
  /** Shown as a Cancel button, and what Escape does. */
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = value.trim();

  const save = async (): Promise<void> => {
    if (key === '' || busy) return;
    setBusy(true);
    try {
      await onSave(key);
      setValue('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-1.5">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            else if (e.key === 'Escape' && onCancel) onCancel();
          }}
          placeholder="Paste the key"
          aria-label={`${label} API key`}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className="h-7 min-w-0 flex-1 rounded-md bg-background px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30"
        />
        <Button size="sm" disabled={key === '' || busy} onClick={() => void save()}>
          {busy && <LoaderCircle className="animate-spin" />}
          Save key
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
