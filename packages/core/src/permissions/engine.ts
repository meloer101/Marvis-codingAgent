import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { inspectBash } from './bash-ast.js';
import { isDroppedAutoAllow } from './auto-allow.js';
import { KNOWN_TOOLS, PLANS_DIR_PREFIX, READ_ONLY_TOOLS } from './defaults.js';
import { ruleMatchesBash, ruleMatchesMcp, ruleMatchesPath, ruleMatchesWebFetch } from './match.js';
import { parseRule } from './parse.js';
import {
  PathEscapeError,
  isInScratch,
  isProtectedPath,
  isSensitivePath,
  sensitiveBashArgs,
  relativeToWorkspace,
  resolveInWorkspace,
} from './paths.js';
import { isReadOnlyBashSegment } from './read-only-bash.js';
import type {
  EvaluateRequest,
  PermissionMode,
  PermissionRule,
  PermissionVerdict,
} from './types.js';

export interface PermissionEngineOptions {
  workspaceRoot: string;
  mode: PermissionMode;
  allow: string[];
  ask: string[];
  deny: string[];
  classifyAllShell?: boolean;
  /** When true, non-read-only bash in plan mode is classified instead of denied. */
  useAutoModeDuringPlan?: boolean;
}

export class PermissionEngine {
  private readonly workspaceRoot: string;
  private mode: PermissionMode;
  private allow: PermissionRule[];
  private askRules: PermissionRule[];
  private deny: PermissionRule[];
  /** What `addAllowRule` granted this session: kept when the configured rules change. */
  private readonly added: PermissionRule[] = [];
  private readonly classifyAllShell: boolean;
  private readonly useAutoModeDuringPlan: boolean;

  constructor(opts: PermissionEngineOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.mode = opts.mode;
    this.allow = opts.allow.map(parseRule);
    this.askRules = opts.ask.map(parseRule);
    this.deny = opts.deny.map(parseRule);
    this.classifyAllShell = opts.classifyAllShell === true;
    this.useAutoModeDuringPlan = opts.useAutoModeDuringPlan === true;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Switch the active mode. Used by Step 3's post-approval transition out of plan mode. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Append an allow rule at runtime — the "always allow, this session" path.
   * Whole-tool granularity only (`Bash`, not `Bash(npm test:*)`); reverse-engineering
   * a safe specifier prefix from one concrete call is error-prone, so this stays
   * coarse and the caller echoes exactly what was added.
   */
  addAllowRule(raw: string): void {
    const rule = parseRule(raw);
    this.added.push(rule);
    this.allow.push(rule);
  }

  /**
   * Replace the configured rules — the settings they came from changed. What
   * `addAllowRule` granted this session stays. Throws, changing nothing, on a
   * rule that doesn't parse.
   */
  setRules(rules: { allow: string[]; ask: string[]; deny: string[] }): void {
    const allow = rules.allow.map(parseRule);
    const ask = rules.ask.map(parseRule);
    const deny = rules.deny.map(parseRule);
    this.allow = [...allow, ...this.added];
    this.askRules = ask;
    this.deny = deny;
  }

  async evaluate(req: EvaluateRequest): Promise<PermissionVerdict> {
    const tool = req.toolName.toLowerCase();

    // MCP tools (`mcp__<server>__<tool>`) are not in KNOWN_TOOLS — they are
    // discovered at runtime. They ride the same allow/ask/deny lists, matched
    // by server or by exact name, and default to "not read-only" so an
    // unlisted one is asked in `ask`/`acceptEdits` and refused in
    // `plan`/`readOnly`, the same as `bash`.
    if (tool.startsWith('mcp__')) {
      return this.evaluateMcp(tool);
    }

    if (!KNOWN_TOOLS.has(tool)) {
      return { decision: 'deny', reason: `Unknown tool "${req.toolName}"` };
    }

    if (tool === 'bash') {
      return this.evaluateBash(req.input);
    }

    if (tool === 'todo') {
      return this.evaluateTodo();
    }

    if (tool === 'skill') {
      return this.evaluateSkill();
    }

    if (tool === 'memory') {
      return this.evaluateMemory();
    }

    if (tool === 'task') {
      return this.evaluateWholeTool('task', false);
    }

    if (tool === 'webfetch') {
      return this.evaluateWebFetch(req.input);
    }

    if (tool === 'exit_plan_mode') {
      return this.evaluateExitPlanMode();
    }

    return this.evaluatePathTool(tool, req);
  }

  /**
   * `exit_plan_mode` is registered for the whole session — a tool list that
   * changes with the mode invalidates the prompt cache from the first changed
   * token — so the mode check lives here instead: outside plan mode the call is
   * refused with a reason that tells the model what actually happened. Inside
   * plan mode it honours an explicit deny rule but is otherwise allowed; the
   * real gate is the human approval the tool itself performs.
   */
  private evaluateExitPlanMode(): PermissionVerdict {
    if (this.mode !== 'plan') {
      return {
        decision: 'deny',
        reason:
          `exit_plan_mode only applies in plan mode, and this session is in ${this.mode} mode — ` +
          'there is no plan to hand over. Carry out the work directly.',
      };
    }
    const denied = this.deny.find((r) => r.tool === 'exit_plan_mode');
    if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
    return { decision: 'allow' };
  }

  /**
   * `webfetch` makes no workspace change, so it counts as read-only for the
   * mode default (allowed in `plan`/`readOnly`/`yolo`, asked in `ask`) — the
   * same stance Claude Code takes. Network egress is instead scoped by rules:
   * a bare `WebFetch` rule, or a per-host `WebFetch(domain:example.com)`.
   * Auto mode still classifies it.
   */
  private evaluateWebFetch(input: unknown): PermissionVerdict {
    const rec = asRecord(input);
    const url = typeof rec.url === 'string' ? rec.url : '';

    const denied = this.deny.find((r) => ruleMatchesWebFetch(r, url));
    if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
    const allowed = this.effectiveAllow().find((r) => ruleMatchesWebFetch(r, url));
    if (allowed) return { decision: 'allow' };
    const asked = this.askRules.find((r) => ruleMatchesWebFetch(r, url));
    if (asked) return { decision: 'ask', reason: `Requires approval (${asked.raw})`, forcedByRule: true };

    return this.modeDefault('webfetch', true);
  }

  private evaluateMcp(tool: string): PermissionVerdict {
    const denied = this.deny.find((r) => ruleMatchesMcp(r, tool));
    if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
    const allowed = this.effectiveAllow().find((r) => ruleMatchesMcp(r, tool));
    if (allowed) return { decision: 'allow' };
    const asked = this.askRules.find((r) => ruleMatchesMcp(r, tool));
    if (asked) return { decision: 'ask', reason: `Requires approval (${asked.raw})`, forcedByRule: true };
    return this.modeDefault(tool, false);
  }

  /**
   * A tool with no path / command specifier: `todo`, `skill`, `memory`, `task`.
   * Whole-tool `deny`/`allow`/`ask` rules apply, then the mode default. `skill`,
   * `todo`, and `memory` pass `readOnly: true` (no workspace effect, so
   * `plan`/`readOnly` allow them); `task` passes `false`.
   */
  private evaluateWholeTool(tool: string, readOnly: boolean): PermissionVerdict {
    const denied = this.deny.find((r) => r.tool === tool);
    if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
    const allowed = this.effectiveAllow().find((r) => r.tool === tool);
    if (allowed) return { decision: 'allow' };
    const asked = this.askRules.find((r) => r.tool === tool);
    if (asked) return { decision: 'ask', reason: `Requires approval (${asked.raw})`, forcedByRule: true };
    return this.modeDefault(tool, readOnly);
  }

  private evaluateSkill(): PermissionVerdict {
    return this.evaluateWholeTool('skill', true);
  }

  private evaluateTodo(): PermissionVerdict {
    return this.evaluateWholeTool('todo', true);
  }

  private evaluateMemory(): PermissionVerdict {
    return this.evaluateWholeTool('memory', true);
  }

  private async evaluateBash(input: unknown): Promise<PermissionVerdict> {
    const rec = asRecord(input);
    const command = typeof rec.command === 'string' ? rec.command : '';
    const inspected = inspectBash(command, { workspaceRoot: this.workspaceRoot });
    if (inspected.hardDenyReason) {
      if (inspected.unreviewable) return this.evaluateUnreviewable(command, inspected.hardDenyReason);
      return { decision: 'deny', reason: inspected.hardDenyReason };
    }

    if (typeof rec.cwd === 'string') {
      try {
        await resolveInWorkspace(this.workspaceRoot, rec.cwd);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return { decision: 'deny', reason: err.message };
        }
        throw err;
      }
    }

    const segs = inspected.segments;
    for (const seg of segs) {
      const denied = this.deny.find((r) => ruleMatchesBash(r, seg));
      if (denied) {
        return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
      }
    }

    // A command that reads a secret is not harmless just because it writes
    // nothing, so this sits above the allow rules — same stance as the sensitive
    // check for `read`/`edit`. Only a rule that names the file itself
    // (`Bash(cat .env)`) can override it; a command-prefix rule cannot.
    const sensitive = sensitiveBashArgs(segs);
    if (sensitive.length > 0) {
      const named = this.effectiveAllow().find(
        (r) =>
          r.pattern !== undefined &&
          sensitive.some((p) => r.pattern?.includes(p)) &&
          segs.some((seg) => ruleMatchesBash(r, seg)),
      );
      if (!named) {
        return {
          decision: 'deny',
          reason: `Refusing to access sensitive file ${sensitive[0]}`,
        };
      }
      return { decision: 'allow' };
    }

    // `cd <the workspace root>` changes nothing — every relative path after it
    // means what it meant before — but agents prefix it out of habit
    // (`cd /abs/workspace && npm test`), and it alone made an allowed command
    // ask. It is dropped here, for the allow and read-only checks only (deny
    // rules, ask rules and the sensitive-file check above still see it). Only
    // the root: `cd .git && cat config` would slip past the sensitive-path
    // check, so a `cd` anywhere else still counts.
    const effective = await this.withoutNoOpCd(segs);
    if (segs.length > 0 && effective.length === 0) return { decision: 'allow' };

    const allow = this.effectiveAllow();
    if (effective.length > 0 && effective.every((seg) => allow.some((r) => ruleMatchesBash(r, seg)))) {
      return { decision: 'allow' };
    }

    for (const seg of segs) {
      const asked = this.askRules.find((r) => ruleMatchesBash(r, seg));
      if (asked) {
        return { decision: 'ask', reason: `Requires approval (${asked.raw})`, forcedByRule: true };
      }
    }

    // Read-only commands are allowed in every mode, and a read-only segment may
    // ride along with allowed ones — `npm test 2>&1 | tail` off a `Bash(npm:*)`
    // rule, `ls -la && cat package.json` off none at all. Exploration was the
    // single biggest source of denials in the traces, and a `| tail` cannot do
    // anything the command before it could not.
    const readOnly = (seg: string[]): boolean =>
      !inspected.hasWriteRedirect && isReadOnlyBashSegment(seg);
    if (effective.length > 0 && effective.every((seg) => readOnly(seg) || allow.some((r) => ruleMatchesBash(r, seg)))) {
      return { decision: 'allow' };
    }

    return this.modeDefault('bash', false);
  }

  /** `segments` minus any `cd <path>` whose path is the workspace root itself. */
  private async withoutNoOpCd(segments: string[][]): Promise<string[][]> {
    const out: string[][] = [];
    for (const seg of segments) {
      if (seg.length === 2 && seg[0] === 'cd' && (await this.isWorkspaceRoot(seg[1] as string))) continue;
      out.push(seg);
    }
    return out;
  }

  private async isWorkspaceRoot(target: string): Promise<boolean> {
    // `-`, `~` and variables resolve somewhere the parser can't see.
    if (target === '' || target.startsWith('-') || target.startsWith('~') || target.includes('$')) return false;
    const abs = isAbsolute(target) ? target : resolve(this.workspaceRoot, target);
    const real = (p: string): Promise<string> => realpath(p).catch(() => resolve(p));
    return (await real(abs)) === (await real(this.workspaceRoot));
  }

  /**
   * A command that could not be parsed into segments: inline interpreter
   * code, `$(...)`, a heredoc. Nothing here can check what it will run, so the
   * decision goes to whoever can: in `ask` / `acceptEdits` the person
   * approving, who can read the whole command; in `auto` the classifier; in
   * `yolo` nobody reviews anything, and the same code written to a file would
   * run anyway, so it is allowed (in the Terminal-Bench run refusing these was
   * 10% of all tool calls). `plan` and `readOnly` still refuse — they can't
   * know it is read-only. In every mode what the user configured still holds:
   * a `Bash` deny rule, matched on the raw text since there are no segments,
   * and the sensitive-file stance. Destructive commands never reach here
   * (`inspectBash` refuses them first).
   */
  private evaluateUnreviewable(command: string, reason: string): PermissionVerdict {
    for (const rule of this.deny) {
      if (rule.tool !== 'bash') continue;
      if (rule.pattern === undefined || mentionsCommand(command, rule.pattern)) {
        return { decision: 'deny', reason: `Blocked by deny rule ${rule.raw}` };
      }
    }
    // Only words that look like paths: `load_credentials()` in inline code is
    // not a file, `.env` and `config/credentials.json` are.
    const sensitive = (command.match(/[\w.~/-]+/g) ?? []).find(
      (word) => /[./]/.test(word) && isSensitivePath(word),
    );
    if (sensitive) {
      return { decision: 'deny', reason: `Refusing to access sensitive file ${sensitive}` };
    }
    switch (this.mode) {
      case 'yolo':
        return { decision: 'allow' };
      case 'auto':
        return { decision: 'classify' };
      case 'ask':
      case 'acceptEdits':
        return { decision: 'ask', reason: unreviewableAskReason(reason) };
      default:
        return { decision: 'deny', reason };
    }
  }

  private async evaluatePathTool(tool: string, req: EvaluateRequest): Promise<PermissionVerdict> {
    const target = pathFromInput(tool, req.input);

    let rel: string | undefined;
    if (target !== undefined) {
      try {
        rel = await relativeToWorkspace(this.workspaceRoot, target);
      } catch (err) {
        if (!(err instanceof PathEscapeError)) throw err;
        if (await isInScratch(target, this.workspaceRoot)) return this.evaluateScratchPath(tool, target, req);
        return { decision: 'deny', reason: err.message };
      }
    }

    const protectedWrite =
      rel !== undefined && (tool === 'write' || tool === 'edit') && isProtectedPath(rel);

    if (rel !== undefined) {
      const denied = this.deny.find((r) => ruleMatchesPath(r, tool, rel));
      if (denied) {
        return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
      }

      if (isSensitivePath(rel)) {
        const specificAllow = this.effectiveAllow().find(
          (r) => r.pattern !== undefined && ruleMatchesPath(r, tool, rel),
        );
        if (!specificAllow) {
          return { decision: 'deny', reason: `Refusing to access sensitive file ${rel}` };
        }
        return { decision: 'allow' };
      }

      // A protected path is covered only by a rule that names it (`Edit(tsconfig.json)`),
      // never by a whole-tool `Write` / `Edit` — same stance as sensitive paths above.
      const allowed = this.effectiveAllow().find(
        (r) => (!protectedWrite || r.pattern !== undefined) && ruleMatchesPath(r, tool, rel),
      );
      if (allowed) return { decision: 'allow' };

      const asked = this.askRules.find((r) => ruleMatchesPath(r, tool, rel));
      if (asked) {
        return { decision: 'ask', reason: `Requires approval (${asked.raw})`, forcedByRule: true };
      }
    } else {
      const denied = this.deny.find((r) => r.tool === tool && r.pattern === undefined);
      if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
      const allowed = this.effectiveAllow().find((r) => r.tool === tool && r.pattern === undefined);
      if (allowed && !protectedWrite) return { decision: 'allow' };
      const asked = this.askRules.find((r) => r.tool === tool && r.pattern === undefined);
      if (asked) return { decision: 'ask', reason: `Requires approval (${asked.raw})`, forcedByRule: true };
    }

    return this.modeDefault(tool, req.readOnly || READ_ONLY_TOOLS.has(tool), rel, protectedWrite);
  }

  /**
   * A file tool on a path in the system temp dir. Rules are written against
   * workspace-relative paths, so none of them apply; the sensitive-file stance
   * does, and otherwise the mode decides exactly as for a workspace path —
   * `ask` asks, `plan` and `readOnly` refuse writes, `yolo` allows.
   */
  private evaluateScratchPath(tool: string, target: string, req: EvaluateRequest): PermissionVerdict {
    if (isSensitivePath(target)) {
      return { decision: 'deny', reason: `Refusing to access sensitive file ${target}` };
    }
    return this.modeDefault(tool, req.readOnly || READ_ONLY_TOOLS.has(tool));
  }

  private effectiveAllow(): PermissionRule[] {
    if (this.mode !== 'auto') return this.allow;
    return this.allow.filter((r) => !isDroppedAutoAllow(r, this.classifyAllShell));
  }

  private modeDefault(
    tool: string,
    readOnly: boolean,
    rel?: string,
    protectedWrite = false,
  ): PermissionVerdict {
    switch (this.mode) {
      case 'yolo':
        return { decision: 'allow' };
      case 'auto':
        return autoModeDefault(tool, readOnly, protectedWrite);
      case 'readOnly':
        if (readOnly || tool === 'todo') return { decision: 'allow' };
        return {
          decision: 'deny',
          reason: `"${tool}" is not allowed in ${this.mode} mode`,
        };
      case 'plan':
        if (readOnly || tool === 'todo') return { decision: 'allow' };
        // The one write path plan mode leaves open: the plan file itself.
        // `rel` is relative to workspaceRoot (--cwd); when --cwd is a project
        // subdirectory, `.agent` sits outside the cage and this never matches —
        // but exit_plan_mode writes its file through fs directly, so the main
        // path is unaffected.
        if (
          (tool === 'write' || tool === 'edit') &&
          rel !== undefined &&
          rel.startsWith(PLANS_DIR_PREFIX)
        ) {
          return { decision: 'allow' };
        }
        if (tool === 'bash' && this.useAutoModeDuringPlan) {
          return { decision: 'classify' };
        }
        return {
          decision: 'deny',
          reason: `"${tool}" is not allowed in ${this.mode} mode`,
        };
      case 'acceptEdits':
        if (protectedWrite) {
          return { decision: 'ask', reason: `${tool} writes a protected path` };
        }
        if (tool === 'write' || tool === 'edit' || readOnly || tool === 'todo') {
          return { decision: 'allow' };
        }
        if (tool === 'bash') {
          return { decision: 'ask', reason: 'bash requires approval in acceptEdits mode' };
        }
        return { decision: 'ask', reason: `${tool} requires approval` };
      case 'ask':
      default:
        return { decision: 'ask', reason: `${tool} requires approval in ask mode` };
    }
  }
}

/** Why an unreviewable command is being put to the person approving it — and how to avoid the prompt. */
function unreviewableAskReason(reason: string): string {
  const inline = /inline code via (\S+)/.exec(reason);
  const what = inline
    ? `inline ${inline[1]} code`
    : /substitution/i.test(reason)
      ? 'command substitution ($(...) or backticks)'
      : 'a shape the reviewer cannot parse (a heredoc or subshell)';
  return (
    `This command contains ${what}, which can't be checked automatically, so it needs approval. ` +
    `Writing the code to a file in the scratch (system temp) directory and running that avoids the prompt.`
  );
}

/**
 * Whether `command` invokes the command a `Bash(<pattern>)` rule names, judged
 * on raw text: the pattern's command words (before any `:*` or `*`) appearing
 * as whole words. Over-matches on purpose — it only ever turns an allow into a
 * deny.
 */
function mentionsCommand(command: string, pattern: string): boolean {
  const prefix = pattern.replace(/:\*$/, '').replace(/\*+$/, '').trim();
  if (prefix === '') return true;
  const words = prefix.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(^|[^\\w./-])${words.join('\\s+')}($|[^\\w./-])`).test(command);
}

function autoModeDefault(tool: string, readOnly: boolean, protectedWrite: boolean): PermissionVerdict {
  if (tool === 'webfetch' || tool === 'task' || tool.startsWith('mcp__')) {
    return { decision: 'classify' };
  }
  if (protectedWrite) return { decision: 'classify' };
  if (readOnly || tool === 'todo') return { decision: 'allow' };
  if (tool === 'write' || tool === 'edit') return { decision: 'allow' };
  return { decision: 'classify' };
}

export function createPermissionEngine(opts: PermissionEngineOptions): PermissionEngine {
  return new PermissionEngine(opts);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') return input as Record<string, unknown>;
  return {};
}

function pathFromInput(tool: string, input: unknown): string | undefined {
  const rec = asRecord(input);
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.cwd === 'string') return rec.cwd;
  if (tool === 'glob' || tool === 'grep') return '.';
  return undefined;
}
