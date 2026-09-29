/**
 * Context compaction.
 *
 * Mechanism follows Claude Code: at a token-pressure threshold, hand the oldest
 * span of history to the model for a structured summary, then continue with
 * `[original goal + digest]` followed by the last few turns kept verbatim.
 *
 * Digest *content* follows Manus: beyond task state (decisions, files touched,
 * open problems) it distills the working style — how the user and agent have
 * been collaborating, the code / tool / output conventions in play — so that
 * behaviour survives the compaction, not just facts. The static baseline (the
 * agent's own conventions block) is passed in; the digest records only the
 * deviations from it, which keeps it small.
 *
 * `compactMessages` and the split helpers are pure and unit-tested;
 * `createCompactor` wires them to a provider and returns an `onCompact` hook.
 */

import type { AgentHooks } from '../agent/hooks.js';
import type { Message, Provider, ReasoningEffort } from '../provider/types.js';
import { ProviderError, textOf } from '../provider/types.js';
import { errorMessage } from '../tools/util.js';
import { flattenRequestText, heuristicTokenCount } from './tokenizer.js';
import { ToolOutputStore } from './tool-output.js';
import { truncateHeadTail } from './truncate.js';

/** Separates the verbatim original goal from the digest inside the merged head. */
export const COMPACTION_MARKER = '\n\n---\n[此前对话已压缩 · compacted]\n';

export const DEFAULT_KEEP_TURNS = 3;
export const DEFAULT_MIN_COMPACT_TOKENS = 2000;
export const DEFAULT_DIGEST_TOKEN_BUDGET = 1800;

/** Times a summarization that overflows its window is retried with the oldest quarter of turns dropped. */
const MAX_OVERFLOW_RETRIES = 4;

/**
 * Follows the digest inside the merged head: the user's own messages from the
 * compacted span, verbatim, so a correction the digest glossed over survives.
 */
export const RECENT_USER_MARKER = '\n\n---\n[压缩前的用户消息（原文） · recent user messages, verbatim]\n';
const USER_MESSAGE_SEPARATOR = '\n\n· · ·\n\n';
/** Token budget for the verbatim user messages (codex keeps up to 20k). */
export const DEFAULT_KEEP_USER_MESSAGES_TOKENS = 20_000;
/** Below this much budget left, a message that doesn't fit is dropped rather than cut. */
const MIN_USER_MESSAGE_SLICE_TOKENS = 200;

/** Recent tool-output tokens kept verbatim when pruning before a full summary. */
export const DEFAULT_PRUNE_PROTECT_TOKENS = 40_000;
/** Minimum reclaimable tokens before prune actually rewrites history. */
export const DEFAULT_PRUNE_MIN_RECLAIM_TOKENS = 20_000;
/** Tool names whose results are never pruned (e.g. skill manifests). */
export const DEFAULT_PRUNE_PROTECTED_TOOLS = ['skill'] as const;

/** Marker prefix for a pruned tool_result — also used to skip re-pruning. */
export const PRUNED_TOOL_RESULT_PREFIX = '[pruned tool output:';


// ---------------------------------------------------------------------------
// Pure splitting / assembly
// ---------------------------------------------------------------------------

export interface CompactionSplit {
  /** Messages to be summarized away. */
  middle: Message[];
  /** Trailing turns kept verbatim. */
  tail: Message[];
  /** Number of turns in `tail`. */
  keptTurns: number;
}

/**
 * Group everything after the head into turns. A turn begins at an assistant
 * message or a fresh user *text* prompt; a user message carrying `tool_result`
 * blocks attaches to the group before it — so an assistant `tool_use` and its
 * result are never split across a cut.
 */
function groupTurns(rest: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  let cur: Message[] = [];
  for (const m of rest) {
    const isToolResult = m.role === 'user' && m.content.some((b) => b.type === 'tool_result');
    if (isToolResult) {
      cur.push(m);
    } else {
      if (cur.length > 0) groups.push(cur);
      cur = [m];
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * Split `messages` into `[head] + middle + tail`, cutting only on turn
 * boundaries. Returns `undefined` when there is nothing worth compacting
 * (too few turns, or an empty middle).
 */
export function splitForCompaction(
  messages: readonly Message[],
  keepTurns: number,
): CompactionSplit | undefined {
  if (messages.length < 2) return undefined;
  const groups = groupTurns(messages.slice(1));
  if (groups.length <= keepTurns) return undefined;
  const tailGroups = groups.slice(groups.length - keepTurns);
  const middle = groups.slice(0, groups.length - keepTurns).flat();
  if (middle.length === 0) return undefined;
  return { middle, tail: tailGroups.flat(), keptTurns: tailGroups.length };
}

/**
 * Pull the verbatim goal, any prior digest, and any user messages an earlier
 * compaction kept verbatim back out of a (possibly already compacted) head.
 */
export function parseGoalAndPriorDigest(head: Message): {
  goal: string;
  priorDigest?: string;
  recentUserMessages?: string[];
} {
  const text = textOf(head.content);
  const i = text.indexOf(COMPACTION_MARKER);
  if (i === -1) return { goal: text };
  const rest = text.slice(i + COMPACTION_MARKER.length);
  // lastIndexOf: the section is always appended last, and a digest that echoed
  // the marker must not be mistaken for it.
  const j = rest.lastIndexOf(RECENT_USER_MARKER);
  if (j === -1) return { goal: text.slice(0, i), priorDigest: rest };
  return {
    goal: text.slice(0, i),
    priorDigest: rest.slice(0, j),
    recentUserMessages: rest.slice(j + RECENT_USER_MARKER.length).split(USER_MESSAGE_SEPARATOR),
  };
}

/**
 * Assemble the compacted history: one user message holding the verbatim goal,
 * the fresh digest and the kept user messages, then the kept tail. Merging into
 * the head (rather than inserting a new message) keeps roles alternating in the
 * common case where the tail starts with an assistant message.
 */
export function compactMessages(
  goal: string,
  digest: string,
  tail: readonly Message[],
  recentUserMessages: readonly string[] = [],
): Message[] {
  const kept =
    recentUserMessages.length > 0
      ? `${RECENT_USER_MARKER}${recentUserMessages.join(USER_MESSAGE_SEPARATOR)}`
      : '';
  const mergedHead: Message = {
    role: 'user',
    content: [
      { type: 'text', text: `${goal.trimEnd()}${COMPACTION_MARKER}${digest.trim()}${kept}` },
    ],
  };
  return [mergedHead, ...tail];
}

/**
 * The user's own prompts about to be compacted away (plus any an earlier
 * compaction kept), newest first until `budgetTokens` is spent, returned in
 * chronological order. The message that crosses the budget is cut to fit
 * rather than dropped, unless too little budget is left to be worth it.
 */
export function selectRecentUserMessages(
  prior: readonly string[],
  middle: readonly Message[],
  budgetTokens: number,
): string[] {
  const candidates = [...prior];
  for (const m of middle) {
    if (m.role !== 'user' || m.content.some((b) => b.type === 'tool_result')) continue;
    const text = textOf(m.content).trim();
    if (text !== '') candidates.push(text);
  }
  const kept: string[] = [];
  let left = budgetTokens;
  for (let i = candidates.length - 1; i >= 0 && left > 0; i--) {
    const text = candidates[i]!;
    const tokens = heuristicTokenCount(text);
    if (tokens <= left) {
      kept.push(text);
      left -= tokens;
      continue;
    }
    if (left >= MIN_USER_MESSAGE_SLICE_TOKENS) {
      const keepChars = Math.floor((left * text.length) / tokens);
      kept.push(
        truncateHeadTail(text, {
          maxChars: 0,
          headChars: Math.floor(keepChars / 2),
          tailChars: Math.floor(keepChars / 2),
        }).text,
      );
    }
    break;
  }
  return kept.reverse();
}

// ---------------------------------------------------------------------------
// Cheap prune: clear old tool outputs before a full LLM summary
// ---------------------------------------------------------------------------

export interface PruneToolOutputsOptions {
  /** Recent tool-output tokens kept verbatim. Default 40_000. */
  protectTokens?: number;
  /** Skip rewrite when reclaimable tokens are below this. Default 20_000. */
  minReclaimTokens?: number;
  /** Tool names whose results are never pruned. Default `['skill']`. */
  protectedTools?: readonly string[];
}

export interface PruneToolOutputsResult {
  messages: Message[];
  /** Heuristic tokens removed from tool_result bodies (0 ⇒ messages unchanged). */
  reclaimedTokens: number;
  /** Original bodies that were replaced with placeholders, for optional offload. */
  pruned: PrunedToolOutput[];
}

export interface PrunedToolOutput {
  msgIdx: number;
  blockIdx: number;
  toolName: string;
  content: string;
}

export function fallbackPrunedPlaceholder(toolName: string, chars: number): string {
  return (
    `${PRUNED_TOOL_RESULT_PREFIX} ${toolName}, ${chars} chars] ` +
    `Cleared to free context. Re-call the tool if you still need the output.`
  );
}

export function offloadedPrunedPlaceholder(toolName: string, chars: number, relPath: string): string {
  return (
    `${PRUNED_TOOL_RESULT_PREFIX} ${toolName}, ${chars} chars → ${relPath}] ` +
    `Use the read tool to retrieve the original output.`
  );
}

/**
 * Clear old tool outputs from the recent-past, keeping the newest ~protectTokens
 * of tool output (and any protected tools) intact. Pure: returns the original
 * array reference when nothing is worth reclaiming.
 *
 * Walks newest → oldest. A tool_result whose cumulative (newest-first) token
 * count still fits in the protect window is kept; older ones become a short
 * placeholder. Protected tools (e.g. `skill`) are always kept.
 */
export function pruneToolOutputs(
  messages: readonly Message[],
  opts: PruneToolOutputsOptions = {},
): PruneToolOutputsResult {
  const protectTokens = opts.protectTokens ?? DEFAULT_PRUNE_PROTECT_TOKENS;
  const minReclaim = opts.minReclaimTokens ?? DEFAULT_PRUNE_MIN_RECLAIM_TOKENS;
  const protectedTools = new Set(opts.protectedTools ?? DEFAULT_PRUNE_PROTECTED_TOOLS);

  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use') toolNameById.set(b.id, b.name);
    }
  }

  // Collect (msgIdx, blockIdx, tokens, toolName) for every tool_result, newest last.
  type Hit = { msgIdx: number; blockIdx: number; tokens: number; toolName: string; content: string };
  const hits: Hit[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    if (msg.role !== 'user') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const b = msg.content[bi]!;
      if (b.type !== 'tool_result') continue;
      if (b.content.startsWith(PRUNED_TOOL_RESULT_PREFIX)) continue;
      const toolName = toolNameById.get(b.toolUseId) ?? 'unknown';
      hits.push({
        msgIdx: mi,
        blockIdx: bi,
        tokens: heuristicTokenCount(b.content),
        toolName,
        content: b.content,
      });
    }
  }

  // Newest → oldest: keep filling the protect window; once full, prune older.
  let protectedSoFar = 0;
  const toPrune = new Set<string>(); // `${msgIdx}:${blockIdx}`
  let reclaimable = 0;
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]!;
    const key = `${hit.msgIdx}:${hit.blockIdx}`;
    if (protectedTools.has(hit.toolName)) continue;
    if (protectedSoFar >= protectTokens) {
      toPrune.add(key);
      reclaimable += hit.tokens;
      continue;
    }
    protectedSoFar += hit.tokens;
  }

  if (reclaimable < minReclaim || toPrune.size === 0) {
    return { messages: messages as Message[], reclaimedTokens: 0, pruned: [] };
  }

  const pruned: PrunedToolOutput[] = [];
  const out: Message[] = messages.map((msg, mi) => {
    if (msg.role !== 'user') return msg;
    let changed = false;
    const content = msg.content.map((b, bi) => {
      if (b.type !== 'tool_result') return b;
      if (!toPrune.has(`${mi}:${bi}`)) return b;
      changed = true;
      const toolName = toolNameById.get(b.toolUseId) ?? 'unknown';
      pruned.push({ msgIdx: mi, blockIdx: bi, toolName, content: b.content });
      return {
        ...b,
        content: fallbackPrunedPlaceholder(toolName, b.content.length),
      };
    });
    return changed ? { ...msg, content } : msg;
  });

  return { messages: out, reclaimedTokens: reclaimable, pruned };
}

export interface ToolOutputOffloadOptions {
  /** Where pruned bodies are written; shared with the loop's output cap so file names never collide. */
  store: ToolOutputStore;
}

/**
 * Persist pruned tool bodies through `store` and rewrite placeholders to point
 * at the files. A write failure on one body falls back to the re-call
 * placeholder for that body only — never aborts the compaction.
 */
export async function applyToolOutputOffload(
  result: PruneToolOutputsResult,
  opts: ToolOutputOffloadOptions,
): Promise<PruneToolOutputsResult> {
  if (result.pruned.length === 0) return result;

  const replacements = new Map<string, string>();
  for (const hit of result.pruned) {
    const rel = await opts.store.save(hit.content);
    // On failure keep the fallback placeholder already in `result.messages`.
    if (rel === undefined) continue;
    replacements.set(
      `${hit.msgIdx}:${hit.blockIdx}`,
      offloadedPrunedPlaceholder(hit.toolName, hit.content.length, rel),
    );
  }

  if (replacements.size === 0) return result;

  const messages = result.messages.map((msg, mi) => {
    if (msg.role !== 'user') return msg;
    let changed = false;
    const content = msg.content.map((b, bi) => {
      const next = replacements.get(`${mi}:${bi}`);
      if (!next || b.type !== 'tool_result') return b;
      changed = true;
      return { ...b, content: next };
    });
    return changed ? { ...msg, content } : msg;
  });

  return { ...result, messages };
}

// ---------------------------------------------------------------------------
// Digest prompt
// ---------------------------------------------------------------------------

function digestSystemPrompt(conventions: string, budget: number): string {
  return `你在压缩一个 coding agent 的会话历史。把给定的历史片段浓缩成一份结构化 digest，让 agent 读完能无缝继续工作。

严格输出下面三个小节的 markdown，不要有额外前言或结语：

## 任务状态
- 原始目标：<一字不差保留用户的原始目标>
- 进展与关键决策：<做了什么、为什么这么做；架构决策和取舍必须留下>
- 触碰过的文件：<每行 "路径 — 改了什么 / 为什么读"；可以丢文件正文，但一定保留路径>
- 未决事项 / 已知问题 / 下一步
- 关键代码事实：<函数签名、常量名、约定、跑过的命令；标识符保留原文>

## 协作与风格备忘
下面是这个 agent 的基线工作约定：
<baseline>
${conventions}
</baseline>
只记录**观察到的、相对基线的偏差**，四个维度各一行；某维度没有偏差就写"无偏差"：
- 与用户协作：<被用户纠正过的、或明确表达过的偏好：语言、节奏、批准习惯等>
- 代码风格：<相对基线的偏差>
- 工具调用：<相对基线的偏差>
- 输出风格：<相对基线的偏差>

## 安全与权限不变量（永不丢弃）
- 用户明确禁止的操作、路径、范围：逐条保留原文
- 本会话已授予或拒绝的敏感操作边界
即使历史被压缩，这些约束必须出现在 digest 中。没有则写"无"。

保留因果链、已经建立/修改的环境状态、前置条件、以及影响后续决策的线索。具体，不要泛泛而谈。整份 digest 控制在约 ${budget} token 以内。`;
}

function digestUserPrompt(goal: string, priorDigest: string | undefined, middleText: string): string {
  const parts = [`原始目标：\n${goal.trim()}`];
  if (priorDigest && priorDigest.trim() !== '') {
    parts.push(`上一版 digest（在此基础上更新，不要丢信息）：\n${priorDigest.trim()}`);
  }
  parts.push(`需要压缩的历史片段：\n${middleText}`);
  return parts.join('\n\n---\n\n');
}

/**
 * The same instruction as the digest system prompt, phrased as the final user
 * message of a replayed conversation: the history above *is* the span being
 * compacted, so nothing needs to be flattened into the prompt.
 */
function digestReplayPrompt(
  conventions: string,
  budget: number,
  goal: string,
  priorDigest: string | undefined,
): string {
  const parts = [
    '现在停止手上的工作，改为压缩**以上全部对话历史**（最新的几轮除外，它们会原样保留）。',
    digestSystemPrompt(conventions, budget),
    `原始目标：\n${goal.trim()}`,
  ];
  if (priorDigest && priorDigest.trim() !== '') {
    parts.push(`上一版 digest（在此基础上更新，不要丢信息）：\n${priorDigest.trim()}`);
  }
  parts.push('只输出 digest 本身，不要调用任何工具。');
  return parts.join('\n\n---\n\n');
}

const PROHIBITION_RE = /(?:don't|do not|never|不要|禁止|别碰)[^\n]{0,80}/gi;
const MAX_INVARIANTS = 12;

/** Pull never-drop safety constraints out of history (user bans + Denied: results). */
export function extractCompactionInvariants(messages: readonly Message[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string): void => {
    const t = raw.trim();
    if (t === '') return;
    const key = t.toLowerCase();
    if (seen.has(key) || out.length >= MAX_INVARIANTS) return;
    seen.add(key);
    out.push(t);
  };
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'text') {
        for (const match of b.text.matchAll(PROHIBITION_RE)) add(match[0]!);
      } else if (b.type === 'tool_result' && b.content.startsWith('Denied:')) {
        add((b.content.split('\n')[0] ?? b.content).slice(0, 200));
      }
    }
  }
  return out;
}

/** Prepend any invariants the summarizer dropped. No-op when the digest already has them. */
export function ensureInvariants(digest: string, invariants: readonly string[]): string {
  const missing = invariants.filter((inv) => !digest.includes(inv));
  if (missing.length === 0) return digest;
  return `## 安全与权限不变量\n${missing.map((i) => `- ${i}`).join('\n')}\n\n${digest}`;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface CompactorOptions {
  provider: Provider;
  /** Bare model id for the summarization call. */
  model: string;
  /** The agent's own conventions block — the style baseline the digest deviates from. */
  conventions: string;
  keepTurns?: number;
  minCompactTokens?: number;
  digestTokenBudget?: number;
  /**
   * Run a free prune of old tool outputs before asking the model for a digest.
   * Default true — only fires when `onCompact` has already been triggered, so it
   * does not add an extra prefix-cache invalidation beyond the summary itself.
   */
  pruneBeforeSummary?: boolean;
  pruneProtectTokens?: number;
  pruneMinReclaimTokens?: number;
  prunedToolsExempt?: readonly string[];
  /**
   * Ask for the digest by replaying the turn's own prefix (same system segments,
   * same tools, the history verbatim) with the instruction appended as the last
   * user message, instead of flattening the history into a fresh prompt. On an
   * implicit prefix cache that makes almost the whole summarization request a
   * cache hit — DeepSeek bills those at ~1/50 of fresh input.
   *
   * Only valid when the summarizer is the session's own model: another model
   * has its own cache and its own window. Falls back to the flattened prompt
   * whenever the loop passed no prefix (a hook invoked outside a turn).
   */
  warmPrefix?: boolean;
  /** Effort for the summarization call. Summarizing needs little reasoning. */
  summaryEffort?: ReasoningEffort;
  /**
   * Directory for pruned tool-output files (`toolout-<n>.txt`). When set with
   * `cwd`, prune placeholders point at a path the `read` tool can reopen.
   * Write failures fall back to the re-call placeholder and never abort.
   */
  offloadDir?: string;
  cwd?: string;
  writeFile?: (path: string, data: string) => Promise<void>;
  /**
   * Store to offload through instead of `offloadDir`/`cwd` — pass the session's
   * shared store so pruning and the loop's output cap number files together.
   */
  offloadStore?: ToolOutputStore;
  /**
   * Token budget for the user messages kept verbatim after the digest. Default
   * `DEFAULT_KEEP_USER_MESSAGES_TOKENS`; 0 keeps none.
   */
  keepUserMessagesTokens?: number;
  /** Called with a one-line reason whenever compaction is skipped or degraded (empty middle, failed call). */
  onSkip?(reason: string): void;
}

/**
 * Build an `onCompact` hook. Optionally prunes old tool outputs first, then
 * splits history, asks the model for a digest, and returns the compacted list.
 * Any failure is swallowed (logged via `onSkip`) and reported as "no compaction"
 * — the loop's `context_limit` stop remains the safety net, so a broken
 * summarizer degrades gracefully instead of killing the session.
 */
export function createCompactor(opts: CompactorOptions): NonNullable<AgentHooks['onCompact']> {
  const keepTurns = opts.keepTurns ?? DEFAULT_KEEP_TURNS;
  const minCompactTokens = opts.minCompactTokens ?? DEFAULT_MIN_COMPACT_TOKENS;
  const budget = opts.digestTokenBudget ?? DEFAULT_DIGEST_TOKEN_BUDGET;
  const pruneBefore = opts.pruneBeforeSummary !== false;
  const keepUserTokens = opts.keepUserMessagesTokens ?? DEFAULT_KEEP_USER_MESSAGES_TOKENS;
  // One store for the compactor's lifetime: numbering must carry across
  // compactions, or the second one overwrites the files the first pointed at.
  const offloadStore =
    opts.offloadStore ??
    (opts.offloadDir && opts.cwd
      ? new ToolOutputStore(opts.offloadDir, opts.cwd, opts.writeFile)
      : undefined);

  return async (messages, _pressure, ctx) => {
    let working: readonly Message[] = messages;
    let prunedReclaimed = 0;
    if (pruneBefore) {
      let pruned = pruneToolOutputs(messages, {
        ...(opts.pruneProtectTokens !== undefined
          ? { protectTokens: opts.pruneProtectTokens }
          : {}),
        ...(opts.pruneMinReclaimTokens !== undefined
          ? { minReclaimTokens: opts.pruneMinReclaimTokens }
          : {}),
        ...(opts.prunedToolsExempt !== undefined
          ? { protectedTools: opts.prunedToolsExempt }
          : {}),
      });
      if (pruned.reclaimedTokens > 0 && offloadStore) {
        pruned = await applyToolOutputOffload(pruned, { store: offloadStore });
      }
      if (pruned.reclaimedTokens > 0) {
        working = pruned.messages;
        prunedReclaimed = pruned.reclaimedTokens;
      }
    }

    const head = working[0];
    if (!head) return undefined;

    const split = splitForCompaction(working, keepTurns);
    if (!split) {
      if (prunedReclaimed > 0) return { messages: [...working] };
      opts.onSkip?.('compaction skipped: not enough history to compact');
      return undefined;
    }

    const middleText = flattenRequestText({ messages: split.middle });
    if (heuristicTokenCount(middleText) < minCompactTokens) {
      if (prunedReclaimed > 0) return { messages: [...working] };
      opts.onSkip?.('compaction skipped: compactable history below the minimum');
      return undefined;
    }

    const { goal, priorDigest, recentUserMessages } = parseGoalAndPriorDigest(head);
    const warm = opts.warmPrefix === true && ctx.system !== undefined;

    const summarize = (middle: readonly Message[]) =>
      opts.provider.complete({
        model: opts.model,
        // Warm path: the session's own prefix, the history as the model already
        // saw it, and the instruction last. Cold path: one self-contained
        // prompt with the history flattened into it.
        system: warm
          ? [...ctx.system!]
          : [{ id: 'compactor', text: digestSystemPrompt(opts.conventions, budget) }],
        messages: warm
          ? [
              head,
              ...middle,
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: digestReplayPrompt(opts.conventions, budget, goal, priorDigest),
                  },
                ],
              },
            ]
          : [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: digestUserPrompt(goal, priorDigest, flattenRequestText({ messages: middle })),
                  },
                ],
              },
            ],
        // Same tools as the turn, so the cached prefix survives — but the answer
        // is prose, so decoding is constrained away from them.
        ...(warm && ctx.tools ? { tools: [...ctx.tools], toolChoice: 'none' as const } : {}),
        // No `temperature`: thinking-mode endpoints ignore it, and sending it
        // only risks a rejection on the ones that validate it.
        ...(opts.summaryEffort ? { reasoningEffort: opts.summaryEffort } : {}),
        maxOutputTokens: Math.ceil(budget * 1.5),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

    try {
      // The span to summarize can itself overflow the summarizer's window (a
      // smaller `smallModel`, or a history that grew past it). Drop the oldest
      // turns and retry rather than give up on compaction — codex's compact.rs
      // does the same. What is dropped goes unsummarized; the user's own
      // messages in it are still kept verbatim below.
      let middle: readonly Message[] = split.middle;
      let droppedTurns = 0;
      let res: Awaited<ReturnType<typeof summarize>>;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await summarize(middle);
          break;
        } catch (err) {
          const groups = groupTurns(middle);
          const overflow = err instanceof ProviderError && err.kind === 'context_length';
          if (!overflow || attempt >= MAX_OVERFLOW_RETRIES || groups.length <= 1) throw err;
          const drop = Math.max(1, Math.ceil(groups.length / 4));
          middle = groups.slice(drop).flat();
          droppedTurns += drop;
        }
      }
      if (droppedTurns > 0) {
        opts.onSkip?.(
          `compaction: the oldest ${droppedTurns} turn(s) did not fit the summarizer's window and were dropped unsummarized`,
        );
      }
      const digest = ensureInvariants(
        textOf(res.content).trim(),
        extractCompactionInvariants(working),
      );
      if (digest === '') {
        if (prunedReclaimed > 0) return { messages: [...working] };
        opts.onSkip?.('compaction skipped: summarizer returned nothing');
        return undefined;
      }
      return {
        messages: compactMessages(
          goal,
          digest,
          split.tail,
          selectRecentUserMessages(recentUserMessages ?? [], split.middle, keepUserTokens),
        ),
        usage: res.usage,
        keptTurns: split.keptTurns,
      };
    } catch (err) {
      if (prunedReclaimed > 0) return { messages: [...working] };
      opts.onSkip?.(`compaction skipped: ${errorMessage(err)}`);
      return undefined;
    }
  };
}
