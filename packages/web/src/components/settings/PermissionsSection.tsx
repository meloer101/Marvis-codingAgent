import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PermissionRuleList, SettingsView } from '@harness-code/protocol';

import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, Code, ErrorLine, Problems, RuleList, SectionIntro, useLoaded } from './common';

const LISTS: Array<{ list: PermissionRuleList; title: string; hint: string }> = [
  { list: 'allow', title: 'Allow', hint: 'Runs without asking' },
  { list: 'ask', title: 'Ask', hint: 'Asks you first' },
  { list: 'deny', title: 'Deny', hint: 'Never runs' },
];

/**
 * The permission rules in your settings, every project's: three lists edited
 * a rule at a time. A project's own rules are in its `.agent/settings.json`,
 * as in Claude Code. A change reaches the open sessions at once.
 */
export function PermissionsSection({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('settings.get', { workspaceId }), workspaceId);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the settings…</p>;

  const save = (list: PermissionRuleList) => async (rules: string[]) => {
    set(await sync.settingsCall('settings.setRules', { workspaceId, scope: 'user', list, rules }));
  };
  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Permissions">
        What sessions may do without asking you. A rule names a tool — <Code>Bash</Code> — or a tool and what it covers
        — <Code>Bash(npm test:*)</Code>, <Code>Edit(src/**)</Code>, <Code>WebFetch(domain:docs.rs)</Code>. Deny wins
        over ask, ask over allow. These are yours, for every project; a project’s own rules are in its{' '}
        <Code>.agent/settings.json</Code>. Open sessions take a change up at once.
      </SectionIntro>
      <Problems problems={data.problems} />
      <Rules path={data.user.path} rules={data.user.rules} onChange={save} />
      <Builtin rules={data.builtinAllow} />
    </div>
  );
}

function Rules({
  path,
  rules,
  onChange,
}: {
  path: string;
  rules: SettingsView['user']['rules'];
  onChange: (list: PermissionRuleList) => (rules: string[]) => Promise<void>;
}) {
  return (
    <Card label="Your rules" title="Your rules" path={path}>
      <div className="grid gap-4 @xl:grid-cols-3">
        {LISTS.map(({ list, title: listTitle, hint }) => (
          <div key={list} className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-medium">
              {listTitle}{' '}
              <span className="font-normal text-faint tabular-nums">
                {rules[list].length} · {hint}
              </span>
            </h3>
            <RuleList
              label={listTitle}
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
    <section aria-label="Built in" className="px-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-[13px] transition-transform', open && 'rotate-90')} />
        Always allowed, built in: {rules.length} read-only tools and commands
      </button>
      {open && (
        <ul className="mt-2 columns-1 gap-6 pl-5 font-mono text-[11px] text-faint sm:columns-2">
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
