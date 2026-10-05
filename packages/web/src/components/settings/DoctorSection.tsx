import { useEffect, useState } from 'react';
import { Check, ChevronRight, CircleCheck, CircleX, Copy, Info, LoaderCircle, PlugZap, RotateCw, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { DoctorCheck, DoctorReport, DoctorStatus } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { routeToHash } from '@/lib/route';
import type { SettingsSection } from '@/lib/route';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, ErrorLine, SectionIntro, errorText } from './common';

const STATUS: Record<DoctorStatus, { icon: LucideIcon; tone: string; mark: string }> = {
  ok: { icon: CircleCheck, tone: 'text-success', mark: '✓' },
  warn: { icon: TriangleAlert, tone: 'text-warning', mark: '!' },
  error: { icon: CircleX, tone: 'text-destructive', mark: '✗' },
  info: { icon: Info, tone: 'text-faint', mark: '·' },
};

const SECTION_NAMES: Record<NonNullable<DoctorCheck['section']>, string> = {
  models: 'Models',
  permissions: 'Permissions',
  'auto-mode': 'Auto mode',
  memory: 'Memory',
  mcp: 'Connectors',
  skills: 'Skills',
  agents: 'Sub-agents',
  tools: 'Tools',
};

/** The report as text, for a bug report or a message: one line a check, what to do under it. */
export function reportText(report: DoctorReport, projectName: string): string {
  const lines = [`Marvis diagnostics — ${projectName} — ${new Date(report.at).toLocaleString()}${report.connected ? ' (connections checked)' : ''}`];
  for (const group of report.groups) {
    lines.push('', `## ${group.title}`);
    for (const c of group.checks) {
      lines.push(`${STATUS[c.status].mark} ${c.label}: ${c.detail}`);
      if (c.fix && c.status !== 'ok') lines.push(`  → ${c.fix}`);
    }
  }
  return lines.join('\n');
}

/**
 * Diagnostics (`doctor.run`): what Marvis makes of the project's setup, a
 * check a row — the quick ones as the page opens, the connections (the
 * model's provider, each MCP server) on asking — each that isn't fine with
 * what to do and a way to the settings it's fixed in.
 */
export function DoctorSection({ workspaceId, projectName }: { workspaceId: string; projectName: string }) {
  const sync = useSync();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState<'quick' | 'connect' | null>('quick');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (connect: boolean): Promise<void> => {
    setRunning(connect ? 'connect' : 'quick');
    setError(null);
    try {
      setReport(await sync.settingsCall('doctor.run', { workspaceId, ...(connect ? { connect } : {}) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(null);
    }
  };
  useEffect(() => {
    let cancelled = false;
    sync.settingsCall('doctor.run', { workspaceId }).then(
      (r) => !cancelled && setReport(r),
      (err: unknown) => !cancelled && setError(errorText(err)),
    ).finally(() => !cancelled && setRunning(null));
    return () => {
      cancelled = true;
    };
  }, [sync, workspaceId]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const checks = report?.groups.flatMap((g) => g.checks) ?? [];
  const errors = checks.filter((c) => c.status === 'error').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Diagnostics">
        What Marvis makes of this project’s setup: the model and its key, the settings files, permissions, MCP servers,
        skills, sub-agents and memory, and the tools around them. The quick checks read files and spend nothing; checking
        the connections asks the model’s provider for its list of models — no tokens — and starts each MCP server.
      </SectionIntro>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p aria-live="polite" className="min-w-0 flex-1 text-[13px]">
          {!report ? (
            running ? (
              <span className="text-muted-foreground">Checking…</span>
            ) : null
          ) : errors + warnings === 0 ? (
            <span className="flex items-center gap-1.5 text-success">
              <CircleCheck className="size-3.5" />
              Nothing needs you{report.connected ? '' : ' — connections not checked yet'}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              {errors > 0 && <span className="font-medium text-destructive">{errors === 1 ? '1 problem' : `${errors} problems`}</span>}
              {errors > 0 && warnings > 0 && <span className="text-faint">·</span>}
              {warnings > 0 && <span className="font-medium text-warning">{warnings === 1 ? '1 thing to look at' : `${warnings} things to look at`}</span>}
              {!report.connected && <span className="text-muted-foreground">— connections not checked yet</span>}
            </span>
          )}
        </p>
        {report && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigator.clipboard?.writeText(reportText(report, projectName)).then(() => setCopied(true))}
            title="Copy the report as text, for a bug report"
          >
            {copied ? <Check className="text-success" /> : <Copy />}
            {copied ? 'Copied' : 'Copy report'}
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={running !== null} onClick={() => void run(report?.connected === true)}>
          {running === 'quick' && report ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
          Check again
        </Button>
        {!report?.connected && (
          <Button size="sm" disabled={running !== null} onClick={() => void run(true)}>
            {running === 'connect' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
            {running === 'connect' ? 'Connecting…' : 'Check connections'}
          </Button>
        )}
      </div>
      <ErrorLine error={error} />

      {report?.groups.map((group) => (
        <Card key={group.id} label={group.title} title={group.title}>
          <ul className="flex flex-col divide-y">
            {group.checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function CheckRow({ check: c }: { check: DoctorCheck }) {
  const { icon: Icon, tone } = STATUS[c.status];
  const needsYou = c.status === 'error' || c.status === 'warn';
  return (
    <li className="flex items-start gap-2.5 py-2 text-xs first:pt-0 last:pb-0" data-status={c.status}>
      <Icon className={cn('mt-px size-3.5 shrink-0', tone)} aria-label={c.status} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="shrink-0 font-medium">{c.label}</span>
          <span className={cn('min-w-0 break-words', needsYou ? 'text-foreground' : 'text-muted-foreground')}>{c.detail}</span>
        </span>
        {c.fix && needsYou && <span className="text-muted-foreground">{c.fix}</span>}
      </span>
      {c.section && needsYou && (
        <a
          href={routeToHash({ kind: 'settings', section: c.section as SettingsSection })}
          className="flex shrink-0 items-center gap-0.5 rounded-md bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-background/60"
        >
          {SECTION_NAMES[c.section]}
          <ChevronRight className="size-3" />
        </a>
      )}
    </li>
  );
}
