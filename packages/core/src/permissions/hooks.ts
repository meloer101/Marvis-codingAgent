import type { AgentHooks } from '../agent/hooks.js';
import { READ_ONLY_TOOLS } from './defaults.js';
import type { PermissionEngine } from './engine.js';
import type { AskHandler } from './types.js';
import { AutoModeClassifier, classifierDenyMessage } from './auto-mode/classifier.js';
import type { AutoModeState } from './auto-mode/state.js';

export const nonInteractiveAskHandler: AskHandler = async ({ reason }) => ({
  decision: 'deny',
  reason: `${reason} Non-interactive mode requires an explicit --allow rule or --mode yolo.`,
});

export type AutoModeNotice = {
  kind: 'denied' | 'paused' | 'resumed';
  text: string;
  toolName?: string;
  label?: string;
};

export interface AutoModeHookOptions {
  classifier: AutoModeClassifier;
  state: AutoModeState;
  projectMemory?: string;
  onNotice?: (notice: AutoModeNotice) => void;
}

export function createPermissionHooks(
  engine: PermissionEngine,
  ask: AskHandler,
  autoMode?: AutoModeHookOptions,
): AgentHooks {
  return {
    async onBeforeToolCall(call, ctx) {
      const evaluate = () =>
        engine.evaluate({
          toolName: call.name,
          input: call.input,
          readOnly: READ_ONLY_TOOLS.has(call.name.toLowerCase()),
        });

      const verdict = await evaluate();
      if (verdict.decision === 'allow' || verdict.decision === 'deny') return verdict;
      if (verdict.decision === 'ask') {
        return ask({
          toolName: call.name,
          input: call.input,
          reason: verdict.reason,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }

      if (!autoMode) {
        return ask({
          toolName: call.name,
          input: call.input,
          reason: 'auto mode classifier is not attached',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }

      const paused = await autoMode.state.serialize(() => autoMode.state.paused);
      if (paused) {
        const decision = await ask({
          toolName: call.name,
          input: call.input,
          reason: 'auto mode is paused after repeated denials; approve to resume',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (decision.decision === 'allow') {
          autoMode.state.resumeFromApproval();
          autoMode.onNotice?.({
            kind: 'resumed',
            text: 'auto mode resumed after approval',
          });
        }
        return decision;
      }

      const modeBefore = engine.getMode();
      const result = await autoMode.classifier.classify(call, ctx.messages, {
        cwd: ctx.cwd,
        mode: modeBefore,
        ...(autoMode.projectMemory ? { projectMemory: autoMode.projectMemory } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      if (engine.getMode() !== modeBefore) {
        const again = await evaluate();
        if (again.decision === 'allow' || again.decision === 'deny') return again;
        return ask({
          toolName: call.name,
          input: call.input,
          reason: again.decision === 'ask' ? again.reason : 'permission mode changed during classification',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }

      return autoMode.state.serialize(() => applyClassify(call, result, autoMode));
    },
  };
}

function applyClassify(
  call: { id: string; name: string; input: unknown },
  result: Awaited<ReturnType<AutoModeClassifier['classify']>>,
  autoMode: AutoModeHookOptions,
) {
  if (result.decision === 'allow') {
    autoMode.state.recordAllow();
    return { decision: 'allow' as const };
  }
  if (result.countsTowardThreshold) {
    const pause = autoMode.state.recordDenial({
      id: call.id,
      toolName: call.name,
      input: call.input,
      ...(result.label ? { label: result.label } : {}),
      reason: result.reason,
      at: Date.now(),
    });
    const label = result.label ?? 'Uncategorized';
    autoMode.onNotice?.({
      kind: 'denied',
      toolName: call.name,
      label,
      text: `${call.name} denied by auto mode · [${label}] · /permissions`,
    });
    if (pause === 'pause') {
      autoMode.onNotice?.({
        kind: 'paused',
        text: 'auto mode paused after repeated denials; later actions need approval',
      });
    }
  }
  return {
    decision: 'deny' as const,
    reason: classifierDenyMessage(result.label, result.reason),
  };
}
