import { useState } from 'react';
import { Check, ChevronRight, Pause, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';

import type { AutoModeGroup, SessionDenials } from '@harness-code/protocol';

import { relativeTime } from '@/lib/format';
import { routeToHash } from '@/lib/route';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, ErrorLine, Problems, RuleList, SectionIntro, errorText, useLoaded } from './common';

/** In the order the classifier weighs them. */
const GROUPS: Array<{ group: AutoModeGroup; title: string; hint: string }> = [
  {
    group: 'environment',
    title: 'Environment',
    hint: 'What it knows about where you work — your org, trusted repositories, domains, buckets. One “Label: value” a line.',
  },
  { group: 'hard_deny', title: 'Hard deny', hint: 'Always blocked.' },
  { group: 'soft_deny', title: 'Soft deny', hint: 'Blocked, unless an allow exception covers it or you asked for exactly that.' },
  { group: 'allow', title: 'Allow', hint: 'Exceptions to soft deny, applied only as written.' },
];

const DEFAULTS = '$defaults';

/**
 * Auto mode: the rules its classifier decides by — the user's, every
 * project's — and what it refused in the open sessions, each refusal one
 * click from a retry.
 */
export function AutoModeSection({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('settings.get', { workspaceId }), workspaceId);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the settings…</p>;

  const save = (group: AutoModeGroup) => async (rules: string[] | null) => {
    set(await sync.settingsCall('settings.setAutoMode', { workspaceId, group, rules }));
  };
  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Auto mode">
        In auto mode a classifier model decides each call the rules don’t, by these. They are yours, for every
        project — a repository can’t set them. Open sessions take a change up at once.
      </SectionIntro>
      {data.autoMode.unavailable && (
        <Problems problems={[`Auto mode isn’t available in this project: ${data.autoMode.unavailable}.`]} />
      )}
      <Problems problems={data.problems} />
      <Denials workspaceId={workspaceId} />
      <Card label="Classifier rules" title="Classifier rules" path={data.user.path}>
        <div className="flex flex-col divide-y">
          {GROUPS.map((g) => (
            <Group key={g.group} {...g} rules={data.autoMode.rules[g.group]} builtin={data.autoMode.builtin[g.group]} onChange={save(g.group)} />
          ))}
        </div>
      </Card>
    </div>
  );
}

function Group({
  group,
  title,
  hint,
  rules,
  builtin,
  onChange,
}: {
  group: AutoModeGroup;
  title: string;
  hint: string;
  rules: string[] | undefined;
  builtin: string[];
  onChange: (rules: string[] | null) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // No list of its own: the built-in rules, shown as the one row that stands for them.
  const shown = rules ?? [DEFAULTS];
  return (
    <div aria-label={title} role="group" className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-medium">{title}</h3>
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{hint}</span>
        {rules !== undefined && (
          <button
            type="button"
            onClick={() => onChange(null).then(() => setError(null), (err: unknown) => setError(errorText(err)))}
            className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="Use the built-in rules alone again"
          >
            <RotateCcw className="size-3" />
            Built-ins only
          </button>
        )}
      </div>
      <RuleList
        label={`${title} rules`}
        rules={shown}
        placeholder={group === 'environment' ? 'Add — e.g. Trusted repo: github.com/acme/app' : 'Add — Label: what it covers'}
        onChange={onChange}
        render={(rule) => (rule === DEFAULTS ? <BuiltinRules rules={builtin} /> : <LabelledRule rule={rule} />)}
      />
      <ErrorLine error={error} />
    </div>
  );
}

/** `Label: description`, the label in ink. */
function LabelledRule({ rule }: { rule: string }) {
  const colon = rule.indexOf(':');
  if (colon <= 0 || colon > 60) return <>{rule}</>;
  return (
    <>
      <span className="font-medium">{rule.slice(0, colon + 1)}</span>
      <span className="font-sans text-muted-foreground">{rule.slice(colon + 1)}</span>
    </>
  );
}

/** The row `$defaults` stands for: the built-in rules, folded. */
function BuiltinRules({ rules }: { rules: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="flex flex-col font-sans">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        The built-in rules ({rules.length})
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1 pl-4 font-mono">
          {rules.map((r) => (
            <li key={r}>
              <LabelledRule rule={r} />
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/** What auto mode refused in the open sessions of this project, newest first. */
function Denials({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const titles = useAppStore((s) => s.sessions);
  const { data, error, set, reload } = useLoaded(
    () => sync.settingsCall('autoMode.denials', { workspaceId }),
    workspaceId,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const retry = async (session: SessionDenials, denialId: string): Promise<void> => {
    try {
      await sync.settingsCall('session.retryDenied', { id: session.sessionId, denialId });
      setFailed(null);
      set(
        (data ?? []).map((s) =>
          s.sessionId !== session.sessionId
            ? s
            : { ...s, denials: s.denials.map((d) => (d.id === denialId ? { ...d, retry: true } : d)) },
        ),
      );
    } catch (err) {
      setFailed(errorText(err));
    }
  };
  return (
    <Card
      label="Refused"
      title="Refused in the open sessions"
      aside={
        <button
          type="button"
          onClick={reload}
          aria-label="Refresh"
          title="Refresh"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      }
    >
      <ErrorLine error={error ?? failed} />
      {data && data.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing refused — calls auto mode blocks show here while their session is open.</p>
      )}
      <div className="flex flex-col gap-3">
        {data?.map((s) => (
          <div key={s.sessionId} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              <a href={routeToHash({ kind: 'session', id: s.sessionId })} className="truncate font-medium hover:underline">
                {titles.find((t) => t.id === s.sessionId)?.title ?? s.sessionId.slice(0, 8)}
              </a>
              {s.paused && (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-1.5 py-px text-[11px] text-warning"
                  title="After repeated denials, calls ask you until you approve one"
                >
                  <Pause className="size-2.5" />
                  paused
                </span>
              )}
            </div>
            <ul className="flex flex-col">
              {s.denials.map((d) => (
                <li key={d.id} className="flex items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-background">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono" title={d.summary}>
                      <span className="font-medium">{d.toolName}</span> <span className="text-muted-foreground">{d.summary}</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {d.reason} · {relativeTime(d.at)}
                    </span>
                  </span>
                  {d.retry ? (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-success" title="The agent hears so on its next turn">
                      <Check className="size-3" />
                      Retry allowed
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void retry(s, d.id)}
                      className="shrink-0 rounded-md bg-background px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-background/60"
                      title="The agent may make this exact call once more; it hears so on its next turn"
                    >
                      Allow a retry
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

