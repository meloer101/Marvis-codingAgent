import { useMemo, useState } from 'react';
import { BookOpen, Bot, Cpu, Plug, Puzzle, Settings, ShieldCheck, Sparkles, Stethoscope, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { MainHeader, SidebarOpener } from '@/components/Regions';
import { SelectChip } from '@/components/ui/select-chip';
import { routeToHash } from '@/lib/route';
import type { SettingsSection } from '@/lib/route';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { AgentsSection } from './AgentsSection';
import { AutoModeSection } from './AutoModeSection';
import { DoctorSection } from './DoctorSection';
import { McpSection } from './McpSection';
import { MemorySection } from './MemorySection';
import { ModelsSection } from './ModelsSection';
import { PermissionsSection } from './PermissionsSection';
import { SkillsSection } from './SkillsSection';
import { ToolsSection } from './ToolsSection';

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'auto-mode', label: 'Auto mode', icon: Sparkles },
  { id: 'memory', label: 'Memory', icon: BookOpen },
  { id: 'mcp', label: 'Connectors', icon: Plug },
  { id: 'skills', label: 'Skills', icon: Puzzle },
  { id: 'agents', label: 'Sub-agents', icon: Bot },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'doctor', label: 'Diagnostics', icon: Stethoscope },
];

/**
 * Settings (`#/settings/<section>`): models and their keys, permission rules,
 * auto mode and what it refused, memory, connectors, skills, sub-agents —
 * yours, for every project, as in Claude Code: a project's own are files in
 * it. The calls still go through a workspace (the one used last), which
 * settles where home is and what the environment holds. Diagnostics is the
 * one section about a project, chosen there.
 */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const workspaces = useAppStore((s) => s.workspaces);
  const present = useMemo(
    () => workspaces.filter((w) => !w.missing).sort((a, b) => b.lastUsedAt - a.lastUsedAt),
    [workspaces],
  );
  const workspace = present[0];
  const [diagnosed, setDiagnosed] = useState<string | null>(null);
  const doctorOf = present.find((w) => w.id === diagnosed) ?? workspace;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MainHeader>
        <SidebarOpener />
        <Settings className="size-[15px] shrink-0 text-muted-foreground" />
        <span className="text-sm font-semibold">Settings</span>
      </MainHeader>
      {/* Sections beside the page once the column has room for both; tabs above it until then. */}
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-4 px-5 pt-5 pb-6 @3xl:flex-row @3xl:gap-8">
          <nav
            aria-label="Settings sections"
            className="flex shrink-0 gap-0.5 overflow-x-auto @3xl:sticky @3xl:top-0 @3xl:w-44 @3xl:flex-col @3xl:self-start @3xl:overflow-visible"
          >
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={routeToHash({ kind: 'settings', section: s.id })}
                aria-current={section === s.id ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors',
                  section === s.id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-subtle hover:text-foreground',
                )}
              >
                <s.icon className="size-3.5 shrink-0" />
                <span className="whitespace-nowrap">{s.label}</span>
              </a>
            ))}
          </nav>
          <div className="min-w-0 flex-1">
            {!workspace ? (
              <p className="text-xs text-muted-foreground">Add a project to start: settings are read through one.</p>
            ) : section === 'models' ? (
              <ModelsSection key={workspace.id} workspaceId={workspace.id} />
            ) : section === 'permissions' ? (
              <PermissionsSection key={workspace.id} workspaceId={workspace.id} />
            ) : section === 'auto-mode' ? (
              <AutoModeSection key={workspace.id} workspaceId={workspace.id} />
            ) : section === 'memory' ? (
              <MemorySection key={workspace.id} workspaceId={workspace.id} />
            ) : section === 'mcp' ? (
              <McpSection key={workspace.id} workspaceId={workspace.id} />
            ) : section === 'skills' ? (
              <SkillsSection key={workspace.id} workspaceId={workspace.id} />
            ) : section === 'agents' ? (
              <AgentsSection key={workspace.id} workspaceId={workspace.id} />
            ) : section === 'doctor' ? (
              <DoctorSection
                key={doctorOf!.id}
                workspaceId={doctorOf!.id}
                projectName={doctorOf!.name}
                picker={
                  <SelectChip label="Project" value={doctorOf!.id} onChange={setDiagnosed}>
                    {present.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </SelectChip>
                }
              />
            ) : (
              <ToolsSection key={workspace.id} workspaceId={workspace.id} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
