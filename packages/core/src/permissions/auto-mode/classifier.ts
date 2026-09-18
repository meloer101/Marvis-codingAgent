import { addUsage, emptyUsage } from '../../provider/types.js';
import type { Message, ToolUseBlock, Usage } from '../../provider/types.js';
import type { ResolvedModel } from '../../provider/router.js';
import type { Pricing } from '../../provider/capabilities.js';
import type { PermissionMode } from '../types.js';
import { needsDirtyTreeSnapshot, readDirtyTree } from './git-dirty.js';
import { buildClassifierSystemPrompt } from './prompt.js';
import { resolveAutoModeRules } from './rules.js';
import { buildClassifierTranscript } from './transcript.js';
import type { AutoModeConfig } from '../../config/settings.js';

const PHASE1_MAX_TOKENS = 32;
const PHASE2_MAX_TOKENS = 1024;

export interface ClassifierContext {
  cwd: string;
  mode: PermissionMode;
  projectMemory?: string;
  signal?: AbortSignal;
  parentMessages?: readonly Message[];
  delegation?: { name: string; input: unknown };
}

export interface ClassifyResult {
  decision: 'allow' | 'deny';
  label?: string;
  reason: string;
  usage: Usage;
  /** False for model/parse failures — those denials do not trip pause thresholds. */
  countsTowardThreshold: boolean;
  /** The classifier failed (model error, unparseable output) — no safety verdict exists. */
  undetermined?: boolean;
}

export interface AutoModeClassifierOptions {
  model: ResolvedModel;
  autoMode?: AutoModeConfig;
}

export class AutoModeClassifier {
  private readonly model: ResolvedModel;
  private autoMode: AutoModeConfig | undefined;

  constructor(opts: AutoModeClassifierOptions) {
    this.model = opts.model;
    this.autoMode = opts.autoMode;
  }

  /** Pick up `/permissions` edits without reconstructing the classifier. */
  setAutoMode(autoMode: AutoModeConfig | undefined): void {
    this.autoMode = autoMode;
  }

  get ref(): string {
    return this.model.ref;
  }

  get pricing(): Pricing | undefined {
    return this.model.capabilities.pricing;
  }

  async classify(
    call: ToolUseBlock,
    messages: readonly Message[],
    ctx: ClassifierContext,
  ): Promise<ClassifyResult> {
    let dirtyTree: string | undefined;
    if (call.name.toLowerCase() === 'bash') {
      const command = typeof (call.input as { command?: unknown })?.command === 'string'
        ? (call.input as { command: string }).command
        : '';
      if (command && needsDirtyTreeSnapshot(command)) {
        dirtyTree = await readDirtyTree(ctx.cwd);
      }
    }

    const transcript = buildClassifierTranscript(messages, call, {
      ...(ctx.projectMemory ? { projectMemory: ctx.projectMemory } : {}),
      planMode: ctx.mode === 'plan',
      ...(dirtyTree !== undefined ? { dirtyTree } : {}),
      ...(ctx.parentMessages ? { parentMessages: ctx.parentMessages } : {}),
      ...(ctx.delegation ? { delegation: ctx.delegation } : {}),
    });

    const rules = resolveAutoModeRules({ autoMode: this.autoMode });
    const sys1 = buildClassifierSystemPrompt(rules, 'phase1');
    const sys2 = buildClassifierSystemPrompt(rules, 'phase2');

    let usage = emptyUsage();
    try {
      const phase1 = await this.complete(sys1, transcript, PHASE1_MAX_TOKENS, ctx.signal);
      usage = addUsage(usage, phase1.usage);
      const block = parseBlock(phase1.text);
      if (block === 'no') {
        return { decision: 'allow', reason: 'classifier phase 1', usage, countsTowardThreshold: false };
      }

      const phase2 = await this.complete(sys2, transcript, PHASE2_MAX_TOKENS, ctx.signal);
      usage = addUsage(usage, phase2.usage);
      const parsed = parseDecision(phase2.text);
      if (!parsed) {
        return this.undetermined(usage, `unparseable classifier output`);
      }
      if (parsed.decision === 'allow') {
        return {
          decision: 'allow',
          ...(parsed.rule ? { label: parsed.rule } : {}),
          reason: parsed.reason ?? 'classifier phase 2',
          usage,
          countsTowardThreshold: false,
        };
      }
      return {
        decision: 'deny',
        label: parsed.rule ?? 'Uncategorized',
        reason: parsed.reason ?? 'blocked by auto mode classifier',
        usage,
        countsTowardThreshold: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.undetermined(usage, msg);
    }
  }

  private undetermined(usage: Usage, error: string): ClassifyResult {
    return {
      decision: 'deny',
      reason: `auto mode cannot determine the safety of this action (${this.model.ref}: ${error})`,
      usage,
      countsTowardThreshold: false,
      undetermined: true,
    };
  }

  private async complete(
    system: string,
    messages: Message[],
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: Usage }> {
    const res = await this.model.provider.complete({
      model: this.model.model,
      system: [{ id: 'auto_mode_classifier', text: system }],
      messages,
      maxOutputTokens,
      temperature: 0,
      // A classification is a short judgement against a fixed rubric: long
      // reasoning buys nothing and doubles the latency of every gated call.
      ...(this.model.capabilities.reasoning ? { reasoningEffort: 'low' as const } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage: res.usage };
  }
}

function parseBlock(text: string): 'yes' | 'no' | undefined {
  const m = text.match(/<block>\s*(yes|no)\s*<\/block>/i);
  const v = m?.[1]?.toLowerCase();
  return v === 'yes' || v === 'no' ? v : undefined;
}

function parseDecision(
  text: string,
): { decision: 'allow' | 'block'; rule?: string; reason?: string } | undefined {
  const d = text.match(/<decision>\s*(allow|block)\s*<\/decision>/i);
  if (!d?.[1]) return undefined;
  const rule = text.match(/<rule>([\s\S]*?)<\/rule>/i)?.[1]?.trim();
  const reason = text.match(/<reason>([\s\S]*?)<\/reason>/i)?.[1]?.trim();
  return {
    decision: d[1].toLowerCase() === 'allow' ? 'allow' : 'block',
    ...(rule ? { rule } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function classifierDenyMessage(label: string | undefined, reason: string): string {
  const tag = label ? `[${label}] ` : '';
  return (
    `Denied by auto mode classifier: ${tag}${reason}. ` +
    'Treat this boundary in good faith: find a safer way to do the task and do not try to route around it. ' +
    'If the action is truly required, stop and ask the user to authorize it explicitly.'
  );
}
