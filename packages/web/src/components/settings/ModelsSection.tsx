import { useState } from 'react';
import { Check } from 'lucide-react';

import type { ProviderInfo, ProvidersView } from '@harness-code/protocol';

import { KeyField } from '@/components/KeyField';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

import { Card, Code, ErrorLine, Problems, SectionIntro, errorText, useLoaded } from './common';

/** Where a provider's key comes from, said the way the page says it. */
function keyNote(p: ProviderInfo): string {
  switch (p.keySource) {
    case 'user':
      return 'key saved';
    case 'environment':
      return `key from the environment · ${p.keySourceVar}`;
    case 'project':
      return `key in this project’s .env · ${p.keySourceVar}`;
    case 'settings':
      return 'key in settings.json';
    default:
      return p.requiresKey ? 'no key' : 'needs no key';
  }
}

/**
 * Models: the providers models come from, each with its API key, and the
 * model new sessions start on. A key given here is saved in the user's
 * `~/.agent/.env` — every project's — and never shown again.
 */
export function ModelsSection({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('providers.list', { workspaceId }), workspaceId);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the settings…</p>;

  // What the pickers offer follows from both: read it again after a change.
  const changed = (view: ProvidersView): void => {
    set(view);
    void sync.loadModels(workspaceId);
  };
  // The default model's provider first, then the ones with a key; the rest as listed.
  const first = data.model.split('/')[0];
  const rank = (p: ProviderInfo): number => (p.id === first ? 0 : p.keySource ? 1 : 2);
  const providers = [...data.providers].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Models">
        A model is named <Code>provider/model</Code>, and most providers want an API key. A key you give here is saved
        on this machine, in your <Code>~/.agent/.env</Code>, for every project. It is sent to that provider and nowhere
        else, and is not shown again.
      </SectionIntro>
      <Problems problems={data.problems} />
      <DefaultModel view={data} workspaceId={workspaceId} onChanged={changed} />
      <Card label="Providers" title="Providers" path={data.envPath}>
        <ul className="flex flex-col divide-y">
          {providers.map((p) => (
            <Provider key={p.id} provider={p} workspaceId={workspaceId} onChanged={changed} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function DefaultModel({
  view,
  workspaceId,
  onChanged,
}: {
  view: ProvidersView;
  workspaceId: string;
  onChanged: (view: ProvidersView) => void;
}) {
  const sync = useSync();
  const offered = useAppStore((s) => s.models[workspaceId]);
  const [draft, setDraft] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? view.model;
  const provider = view.providers.find((p) => p.id === view.model.split('/')[0]);
  const lacksKey = provider?.requiresKey === true && !provider.keySource;

  const save = async (model: string): Promise<void> => {
    setBusy(true);
    try {
      onChanged(await sync.settingsCall('providers.setModel', { workspaceId, model }));
      setDraft(null);
      setFailed(null);
    } catch (err) {
      setFailed(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card label="Default model" title="Default model" path={view.settingsPath}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <input
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft !== null) void save(draft);
              else if (e.key === 'Escape') setDraft(null);
            }}
            list="offered-models"
            placeholder="provider/model"
            aria-label="Model for new sessions"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className="h-7 min-w-0 flex-1 rounded-md bg-background px-2.5 font-mono text-xs outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <datalist id="offered-models">
            {(offered ?? []).map((m) => (
              <option key={m.ref} value={m.ref} />
            ))}
          </datalist>
          {draft !== null && draft.trim() !== view.model && (
            <Button size="sm" disabled={busy} onClick={() => void save(draft)}>
              Save
            </Button>
          )}
          {view.modelSource === 'user' && draft === null && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save('')}>
              Reset
            </Button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          What a new session starts on; each session can be given another.{' '}
          {view.modelSource === 'project'
            ? 'This project’s settings name it, whatever yours say.'
            : view.modelSource === 'user'
              ? 'From your settings, for every project.'
              : 'The built-in default.'}
          {lacksKey && provider && <span className="mt-1 block text-foreground">{provider.label} has no key yet: give it one below.</span>}
        </p>
        <ErrorLine error={failed} />
      </div>
    </Card>
  );
}

function Provider({
  provider: p,
  workspaceId,
  onChanged,
}: {
  provider: ProviderInfo;
  workspaceId: string;
  onChanged: (view: ProvidersView) => void;
}) {
  const sync = useSync();
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // A key from the environment or the project's .env is used before one saved here.
  const overridden = p.keySource === 'environment' || p.keySource === 'project' || p.keySource === 'settings';

  const remove = async (): Promise<void> => {
    try {
      onChanged(await sync.settingsCall('providers.setKey', { workspaceId, provider: p.id, key: null }));
      setFailed(null);
    } catch (err) {
      setFailed(errorText(err));
    }
  };

  return (
    <li className="flex flex-col gap-1.5 py-2 text-xs first:pt-0 last:pb-0">
      <div className="flex min-h-6 items-center gap-2">
        <span className="shrink-0 font-medium">{p.label}</span>
        <span className="shrink-0 rounded bg-muted px-1 font-mono text-[11px] text-muted-foreground">{p.id}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={p.baseUrl}>
          {p.baseUrl}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={p.keySource ? 'flex items-center gap-1 text-[11px] text-success' : 'text-[11px] text-muted-foreground'}
          >
            {p.keySource && <Check className="size-3" />}
            {keyNote(p)}
          </span>
          {p.keyVar && !overridden && !editing && (
            <>
              <Button size="xs" variant={p.keySource ? 'ghost' : 'outline'} onClick={() => setEditing(true)}>
                {p.keySource ? 'Replace' : 'Add key'}
              </Button>
              {p.keySource === 'user' && (
                <Button size="xs" variant="ghost" onClick={() => void remove()}>
                  Remove
                </Button>
              )}
            </>
          )}
        </span>
      </div>
      {editing && (
        <KeyField
          label={p.label}
          autoFocus
          onCancel={() => setEditing(false)}
          onSave={async (key) => {
            onChanged(await sync.settingsCall('providers.setKey', { workspaceId, provider: p.id, key }));
            setEditing(false);
          }}
        />
      )}
      <ErrorLine error={failed} />
    </li>
  );
}
