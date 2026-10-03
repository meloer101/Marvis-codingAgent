import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PermissionRuleList, SettingsView } from '@harness-code/protocol';

import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, ErrorLine, Problems, RuleList, useLoaded } from './common';

const LISTS: Array<{ list: PermissionRuleList; title: string; hint: string }> = [
  { list: 'allow', title: 'Allow', hint: 'Runs without asking' },
  { list: 'ask', title: 'Ask', hint: 'Asks you first' },
  { list: 'deny', title: 'Deny', hint: 'Never runs' },
];

/**
 * The permission rules in the user's settings and the project's: three lists
 * each, edited a rule at a time. A change reaches the open sessions at once.
 */
export function PermissionsSection({ workspaceId, projectName }: { workspaceId: string; projectName: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('settings.get', { workspaceId }), workspaceId);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the settings…</p>;

  const save = (scope: 'user' | 'project', list: PermissionRuleList) => async (rules: string[]) => {
    set(await sync.settingsCall('settings.setRules', { workspaceId, scope, list, rules }));
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        What sessions may do without asking you. A rule names a tool — <code className="font-mono">Bash</code> — or a
        tool and what it covers — <code className="font-mono">Bash(npm test:*)</code>,{' '}
        <code className="font-mono">Edit(src/**)</code>, <code className="font-mono">WebFetch(domain:docs.rs)</code>.
        Deny wins over ask, ask over allow. Open sessions take a change up at once.
      </p>
      <Problems problems={data.problems} />
      <Layer
        title="Yours"
        note="every project"
        path={data.user.path}
        rules={data.user.rules}
        onChange={(list) => save('user', list)}
      />
      <Layer
        title="This project"
        note={projectName}
        path={data.project.path}
        rules={data.project.rules}
        onChange={(list) => save('project', list)}
      />
      <Builtin rules={data.builtinAllow} />
    </div>
  );
}

function Layer({
  title,
  note,
  path,
  rules,
  onChange,
}: {
  title: string;
  note: string;
  path: string;
  rules: SettingsView['user']['rules'];
  onChange: (list: PermissionRuleList) => (rules: string[]) => Promise<void>;
}) {
  return (
    <Card
      label={title}
      title={
        <>
          {title} <span className="font-normal text-muted-foreground">· {note}</span>
        </>
      }
      path={path}
    >
      <div className="grid gap-4 @xl:grid-cols-3">
        {LISTS.map(({ list, title: listTitle, hint }) => (
          <div key={list} className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-medium">
              {listTitle}{' '}
              <span className="font-mono font-normal text-muted-foreground tabular-nums">{rules[list].length}</span>
              <span className="font-normal text-muted-foreground"> · {hint}</span>
            </h3>
            <RuleList
              label={`${title}: ${listTitle}`}
              rules={rules[list]}
              placeholder="Add a rule"
              onChange={onChange(list)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** The rules every session allows before these — folded, they're long. */
function Builtin({ rules }: { rules: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Built in" className="rounded-lg border border-dashed px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        Always allowed, built in: {rules.length} read-only tools and commands
      </button>
      {open && (
        <ul className="mt-2 columns-1 gap-6 pl-5 font-mono text-[11px] text-muted-foreground sm:columns-2">
          {rules.map((r) => (
            <li key={r} className="break-inside-avoid break-words">
              {r}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
