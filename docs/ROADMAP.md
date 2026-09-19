# Roadmap — what's left to build

> The single forward-looking doc for `harness-code` (`hc`). It lists **only what
> remains** — see [`README.md`](../README.md) for what works today and
> [`PLAN.md`](./PLAN.md) for the phase-by-phase build history and deviation log.
>
> 本文件只保留未完成的工作，分两部分：**§1 部分完成**（写明已完成的部分和剩余工作）
> 和 **§2 全部未完成**。两部分内部都按 harness 分类（A–I）归组。已完成的条目一律删除。
>
> 标有 **[codex]** 的条目来自 2026-09-14 对
> [`openai/codex`](https://github.com/openai/codex)（`main@f8bed26f`）的源码对照，
> 每条都注明借鉴的 codex 文件（路径相对 codex 仓库，省略 `codex-rs/` 前缀）。建议先做
> 4 个 *(S, quick win)* 项——它们都不改变模型看到的提示内容，eval cassette 无需重录。
> 标 **measure** 的条目需要消融 runner 或真实 Harbor 运行来验证效果。
>
> Last consolidated: 2026-09-14.

---

## 1. 部分完成

### A · Model / Provider layer
- **DeepSeek 深度适配** — 已完成 P0（见 [`DEEPSEEK.md`](./DEEPSEEK.md)）：`reasoning_content`
  回传 + 400 自愈、`deepseek-flash` 模型档、effort 按 `effortLevels` 客户端映射（含 `off`
  → `thinking.disabled`）、峰谷定价、`insufficient_system_resource` / 空完成可重试、402 →
  `quota`。P1 已完成暖前缀压缩请求 + `contextBudgetTokens`、effort 传递（子代理 / eval /
  分类器）、空闲超时与 dsh 式重试。线上探针已跑完并固化为
  `scripts/deepseek-probe.mjs`（结论见 DEEPSEEK.md §四 §1；其中一条推翻了"不回传 reasoning
  必 400"的调研结论）。P1 已全部落地：in-history system prompt 按"只发变化的段"实现
  （追加完整 prompt 经实测比改写头部更贵），`exit_plan_mode` 改为常驻注册、由 permission
  engine 按模式拒绝，cassette 已在 `deepseek-flash` 上重录。剩余：P2（工具形态对齐实验，要用
  eval 度量）；*(M)*
- **eval 覆盖模式切换** — 已完成：`plan-then-implement`（plan → 批准 → 实施两回合）加上
  `--ablation system-update`，切换后那一次请求的缓存命中 98.2%（只发变化段）对 13.3%
  （改写头部）。剩余：这个任务只录了一条轨迹（`runs: 1`），两条以上的轨迹在一份 cassette
  里回放不了；要提高统计力得先解决多轨迹回放。*(S)*

### C · Tool system & execution
- **Broaden the structured-error sink** — 已完成：`NoModelConfiguredError` 在
  `--output-format json` / `stream-json` 下输出结构化 JSON（`packages/cli/src/index.ts`
  的 `failWithFormat`）。剩余：其他早于输出 sink 的错误（例如 `buildSessionConfig` 深处
  抛出的未知 provider 名）以及顶层 `unhandledRejection` 仍输出纯文本。*(S)*
- **[codex] MCP `tool_search`** — 已完成：phase-4 spike，
  `packages/core/src/mcp/tool-catalog.ts` 把 MCP 工具划分为 inline / deferred，在 121 个
  工具的场景下每回合约省 77% token（见
  [`phase4-mcp-disclosure-spike.md`](./phase4-mcp-disclosure-spike.md)）；尚未接入 agent
  loop。剩余：按需加载工具（codex 用 BM25 检索 deferred 元数据，加载的工具在下一次请求
  生效，命名空间变化以追加的、有上限的片段通告，见
  `core/src/tools/handlers/tool_search*.rs`、`core/src/mcp_tool_exposure.rs`）、带开关的
  `<available_mcp_tools>` 清单，以及多 server MCP fixture 的 eval。*(M)*

### G · Observability & evaluation
- **Finish the 89-task Harbor benchmark** — 已完成 18/89（DeepSeek 余额中途耗尽）。剩余：
  另外 71 个任务；跑完之前，所有能力声明都标注 **"18/89 provisional"**。受预算和时间
  限制，不是工程工作。*(L)*

### H · Agentic behavior quality
以下行为问题的 prompt 修复都已合入（`AGENT_CONVENTIONS` 中的 `<working_style>` 块等），
但**效果尚未测量**——本地 fixture 复现不了多次尝试 / 优化类的失败模式，需要真实 Harbor
重跑或专门的 eval 信号来确认。

- **Turn-budget nudge 在优化类任务上的回归** — 已完成：60% / 80% / 最后一回合三级 nudge
  （`AgentLoop.turnBudgetNote`），整体净收益 +2/−1，消融 runner 已就绪。剩余：根据任务形态
  信号（如 todo 中的重复迭代模式）有条件地减弱或关闭 nudge，并测量效果。*(M)* — **measure**
- **接近预算上限时的 nudge 文案** — 已完成：80% 档要求"停止探索、提交方案、验证一次后
  结束"，最后一回合要求直接落地到目标文件。剩余：明确"停止打磨、交付当前状态"的文案，
  并考虑超过 90% 后单独的强制收尾模式，针对"纠结细枝末节"的症状。*(S–M)*
- **过度工程 / 简单优先** — 已完成："先试简单方案"的规则已合入。剩余：在 Harbor 上验证它
  能否挽回 `largest-eigenval` 这类任务；eval 检查（diff 大小 / 新文件数）还没做。
  *(M)* — **measure**
- **交付物投入过晚** — 已完成：prompt 规则（"在前三分之一的工作量内动到真正的交付物"）。
  剩余：做遥测代理指标（首次触达交付物的时间），用来实际测量。*(M)* — **measure**
- **Scratch 文件蔓延** — 已完成：prompt 约定（复用同一个 scratch 文件、结束前清理）。
  剩余：在真实运行中验证；只有 prompt 方案不够时，才做结构化方案（harness 强制的
  scratch 目录）。*(S–M)*
- **Stop gate / `onBeforeStop`** — 已完成：hook 接口和续跑上限都已存在
  （`agent/hooks.ts` 的 `onBeforeStop`、`agent/loop.ts`）。剩余：一个真正的消费者——在模型
  宣布完成之前核验任务的验收标准（参考 hermes-agent 的 `verification_stop`）；也可以通过
  §2 B 节的命令 hooks 提供用户可配置的实现。*(M, P2)*
- **最后一回合强制总结** — 已完成：`AgentLoop` 的 `finalSummaryTurn` 选项（最后一回合去掉
  工具、强制给出总结），有测试覆盖，子代理已开启（`subagents/run.ts`）。剩余：主会话目前
  没有开启，需要决定是否开启并测量效果。*(S, P1)*

### Other
- **可写子代理** — 已完成：只读 `explore` 的隔离模式已验证有效；机制上，未声明 `tools` 的
  自定义 agent 会继承父级工具（包括写工具）。剩余：内置并验证过的可写子代理，以及并发
  安全——`task` 被标为 `concurrencySafe`，多个会写文件的子代理并行时可能互相冲突。应在
  大仓库 fixture 验证隔离收益之后再做。

---

## 2. 全部未完成

### A · Model / Provider layer
- **Native Anthropic provider** — Claude is reachable only via OpenRouter/proxy
  today. High strategic value (lets `hc` benchmark against/with Claude), low
  immediate-reliability value. **Deferred, not a current priority.** Additive and
  non-confounding; can proceed independently whenever picked back up. *(M)*
- **[codex] 按模型的 harness 档案** — 把 `capabilities.ts` 从"端点能力"扩展为
  "每个模型的 harness 行为"：工具输出 token 预算、编辑工具形态、提示变体、预算/nudge
  文案、自动压缩阈值、可用窗口余量。codex 把这些都放在 `ModelInfo` 上
  （`protocol/src/openai_models.rs`、`models-manager/models.json`）。`hc` 同时面向强弱
  差异很大的模型，这项收益最明显。*(M)*

### B · Orchestration loop
- **Bounded text-truncation auto-continuation** — a pure-text `max_tokens` stop is
  surfaced as a distinct stop reason (correct), but the loop stops rather than
  offering a bounded hermes-agent-style continuation. Optional enhancement, not
  urgent. *(S, Low)*
- **[codex] 回合中途插话（steering）** — 运行中也接受用户输入，并在下一次模型请求前
  注入；而不是像现在这样由 server 返回 `busy`（`packages/server/src/host.ts`）或被 TUI
  忽略。codex 在每次采样前清空待处理输入队列（`core/src/session/turn.rs` 的
  `run_turn`）。需要 `AgentSession.steer()`、一个协议方法，以及 TUI/web 输入框支持。
  *(M)*
- **[codex] 兼容 Claude 的命令 hooks** — 在 `settings.json` 中按 Claude Code 的 schema
  配置 `hooks`（PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart /
  PreCompact；stdin 传 JSON，退出码 2 表示阻断，stdout 返回 `permissionDecision` /
  `updatedInput` / `additionalContext`），映射到现有的 `AgentHooks`。codex 用的正是这套
  格式，并带 `stop_hook_active` 防死循环、hook 输出超 2.5K tokens 时落盘
  （`hooks/`、`core/src/hook_runtime.rs`）。同时也为 §1 H 节的 Stop gate 提供了可由用户
  配置的消费者。*(M)*
- **[codex] 流式输出期间提前派发工具调用** — 每个 `tool_use` 块一完成就开始执行已放行
  的调用，流结束后按模型发出的顺序收集结果。codex 在 `OutputItemDone` 时就启动，放入
  保序的 future 集合，并用读写锁区分可并行与不可并行的工具
  （`core/src/session/turn.rs`、`core/src/tools/parallel.rs`）。只影响延迟，采纳前先测量。
  *(M)*

### C · Tool system & execution
- **`.env` loaded relative to `process.cwd()`, not `--cwd`** — minor correctness
  wrinkle when running against another directory. *(S, minor)*
- **[codex] 工具输出统一上限 + 超出落盘** *(quick win)* — 目前各工具各自截断：`read`
  没有总上限（2000 行 × 每行 2000 字符），`grep` 允许 10 万字符，`bash` 3 万字符。codex
  在工具输出写入历史的那一刻统一截断到按模型设定的 token 预算（默认 10K），并附
  "原始 token 数 / 总行数"头（`core/src/context_manager/history.rs`、
  `utils/output-truncation/`）。做法：在 `AgentLoop.runToolCalls` 里统一加上限（放在
  `onAfterToolCall` 之前，guardrail 反馈不会被截掉），全文复用压缩器的
  `toolout-<n>.txt` 落盘逻辑写出，结果中给出路径。*(S)*
- **[codex] `edit` 分级模糊匹配** *(quick win)* — `oldString` 精确匹配不到时，按行依次
  忽略行尾空白、首尾空白、归一化 Unicode 标点/空格后重试（仍要求唯一匹配），并在结果
  中注明；仍失败时指出最相近的行。移植自 `apply-patch/src/seek_sequence.rs`。
  `replaceAll` 保持精确匹配；工具描述不变。*(S)*
- **[codex] 后台 shell 进程** — `bash` 增加 `runInBackground`，配合 `bash_output` /
  `bash_kill`，每个会话维护进程表（首尾缓冲、数量上限，中断/关闭时全部结束）。codex
  的 `exec_command` 超过 `yield_time_ms`（默认 10 秒）即返回 session id，再用
  `write_stdin` 轮询（`core/src/unified_exec/`、`core/src/tools/handlers/shell_spec.rs`）。
  主要针对 Harbor 上的长时间构建和服务类任务。会改变工具列表 → 需要重录 cassette。*(M)*

### D · Permissions, safety & sandboxing
- **[codex] 可解释、可自测的规则** — 支持对象形式的规则
  `{ rule, justification?, examples?: { match?, notMatch? } }`：justification 出现在
  deny/ask 的原因里（包括应该改用什么做法），examples 在规则加载时校验，并提供
  `hc permissions check "<cmd>"` 输出 JSON 裁决。codex 的 execpolicy 三者都有
  （`execpolicy/README.md`）。*(S–M)*
- **[codex] "始终允许"时提议前缀规则** — 从 AST 第一段推导出 `Bash(<prefix>:*)`，而不是
  放行整个工具；拒绝过宽的前缀（`python`、`node`、`sh`、`rm`、heredoc），经确认后写入项目
  设置（`execpolicy/src/amend.rs`、
  `prompts/templates/permissions/approval_policy/on_request.md`）。*(M)*
- **[codex] 沙箱拒绝 → 升级重试** — 在 `bash` 中识别 `sandbox-exec` 的写入拒绝；交互模式
  下提供"不带沙箱重试"（批准结果在会话内缓存），否则告诉模型失败原因。codex 的
  orchestrator 流程是：审批 → 选择沙箱 → 执行 → 升级重试，并允许模型自己带着给用户看的
  理由申请升级（`core/src/tools/orchestrator.rs`、`core/src/tools/sandboxing.rs`）。*(M)*
- **[codex] 非交互运行的 Guardian 式审阅** — 不再把所有 `ask` 一律变成拒绝，而是交给一个
  隔离的审阅模型，按风险政策（数据外泄、凭据探测、持久削弱安全、破坏性操作）裁决，出错
  时默认拒绝（`core/src/guardian/`、`core/assets/guardian/policy.md`）。成本高，需先有专门
  的 eval。*(L, stretch)*

### E · Context engineering (in-session)
- **Large-repo exploration fixture** — the `subagents` and `compaction` ablation
  arms can't show their real "isolation/compaction saves context" signal on the
  current 5 small fixtures. A big-repo exploration task is the follow-up that would
  give them a real signal. *(M)*
- **[codex] 状态变化以追加片段注入，而非改写系统提示** — 现在切换模式时，
  `session-runner.ts#buildLoop` 会重建系统提示（`plan_mode` 段）和工具列表（增删
  `exit_plan_mode`），导致整段历史的缓存前缀失效。codex 保持指令和工具不变，只把各个
  类型化"world state"分区（模式、权限策略、已批准前缀、工具命名空间）相对持久化快照的
  差异追加进历史（`core/src/context/world_state/`），同时让模型看到当前生效的权限策略。
  会改变提示内容 → 单独提交并重录 cassette；需测量模式切换后的缓存命中。*(M)*
- **[codex] 压缩时原样保留近期用户消息** *(quick win)* — 除首条目标消息外，在 token 预算
  内把最近的真实用户消息原样保留在压缩后的头部，即使不变式抽取漏掉，用户后来的纠正也
  不会丢。codex 压缩后的历史 = 近期用户消息（≤20K tokens）+ 摘要；如果压缩请求本身超出
  窗口，就裁掉最旧的一项后重试（`core/src/compact.rs`）。*(S)*
- **[codex] 上下文注入规则** — codex 对所有模型可见上下文的改动按以下规则审查：只追加、
  每项有上限、单项 ≤10K tokens、超过 1K tokens 的项需额外审查、每个注入片段都是带标记的
  类型化结构（根 `AGENTS.md` 的 "Model visible context" 一节、
  `context-fragments/src/fragment.rs`）。落到 `hc`：一个带硬上限的共用片段 helper，以及
  project memory 的*总*预算并按字节截断——`context/memory.ts` 目前每个文件限 32 KiB 但按
  字符截取，CJK 内容会超出。*(S)*
- **[codex] 模型可见的上下文预算** — 只提醒一次的剩余 token 提示、`get_context_remaining`
  工具、由模型发起的 `new_context` 换窗，提示文案按模型配置
  （`core/src/session/token_budget.rs`、`core/src/tools/handlers/get_context_remaining_spec.rs`）。
  可作为推送式回合预算 nudge 的替代方案（见 §1 H 节）。*(M, measure)*

### F · Protocol & state sync (web)
- **Markdown raw-display bug** — an unresolved cosmetic issue in the web renderer
  (`Markdown.tsx`/`MarkdownBody.tsx`): some content shows as raw text instead of
  going through the sanitized/highlighted renderer. Pin an exact repro against
  current state, then find the raw-text fallback path. Standalone, low-risk. *(S, Low)*

### G · Observability & evaluation
- **OpenTelemetry exporter** — the telemetry layer's declared stretch; never built.
  A span/metric exporter over the existing trace events. *(M, stretch)*
- **[codex] 上下文布局快照 + 前缀不变式测试** *(quick win)* — 用 `ScriptedProvider` 跑
  多轮测试，断言每次请求的 messages 都是在上一次请求后面追加（append-only）、同一模式下
  系统提示和工具保持一致，再加一份规范化的布局快照。这样提示结构的变化会显示成可审阅的
  diff，而不是表现为 cassette 未命中（`core/tests/common/context_snapshot.rs`、
  `core/tests/suite/prompt_caching.rs`）。*(S)*
- **[codex] 可选的全量调试包** — "先观测、后解释"：只在开启时写出有序的原始事件和精确的
  请求/响应内容，离线还原出每次请求"模型实际看到了什么"（`rollout-trace/README.md`）。
  让 Harbor 事后分析和 §1 H 节的"首次触达交付物时间"指标变得容易；默认 trace 仍不含正文。
  *(M)*
- **[codex] 带生命周期阶段的特性开关注册表** — 类型化的开关（开发中 / 实验 / 稳定 / 弃用
  / 已移除），每个行为改动都放在开关后面，消融测试可以统一切换（`features/src/lib.rs`）。
  *(S–M)*

### I · Operational hardening
- **[codex] 持久化每回合的上下文记录** — 目前会话日志只存消息；codex 还会持久化回合上下文、
  world-state 快照和压缩标记，resume/fork 时能精确还原模型可见的布局和设置
  （`rollout/src/policy.rs`、`core/src/session/rollout_reconstruction.rs`）。这是 E 节
  "状态变化追加注入"在 `--resume` 后依然有效的前提。*(S–M)*

### TUI v1.1 (the Ink TUI shipped v1 — dark theme, streaming markdown, tool cards, modals, slash commands)
- Syntax highlighting in code blocks (`cli-highlight`) — v1 renders code dim.
- Markdown tables (v1 renders them as plain text).
- OSC-11 light-theme auto-detection + `/theme` persistence (light palette is
  wired, but v1 ships dark only and doesn't auto-switch).
- Hand-written multiline editor (in-buffer cursor movement) + input history.
- Per-tool-card focus navigation (v1 has a global "expand last output" toggle).
- Live `/model` switching (v1 shows the model read-only); richer `/mcp` `/skills`
  overlays.
- Windows polish (old-console fallback is REPL; cmd.exe TUI marked unsupported).

### Other
- **`hc eval` thin command** — a `child_process.spawn` wrapper over
  `evals/dist/cli.js` (deliberately *not* an import, to keep fixtures/cassettes out
  of the `hc` binary). `pnpm eval` already exists; this is just the CLI verb.
- **Port the eval harness onto `AgentSession`** — `evals/src/harness.ts` still runs
  its own ~80-line headless distillation. Folding it onto `AgentSession` removes the
  duplication, but is risky: cassettes are keyed on the fingerprinted request, so it
  must call `buildAgentSystemPrompt` byte-for-byte identically or every cassette
  needs re-recording. Isolate in its own commit; revert if it drifts.
- **Per-tool `readOnly`/`concurrencySafe` overrides for MCP tools** — MCP tools are
  hardcoded serial + non-read-only (safe default, same tier as `bash`). A
  per-tool `.mcp.json` override would let known-safe tools run in parallel. No
  consumer today.
- **Standalone `capabilities.yaml`** — capability-bit user overrides currently live
  in `.agent/settings.json` under `capabilities`. The original plan had a separate
  YAML; splitting it back out is cheap if ever wanted. (Flagged "待确认" in the PLAN
  deviation log.)
- **Default `timeoutMs`** — 600 000 ms per request is very generous; consider a
  tighter default. *(minor)*
- **`npm publish`** — 目前通过 GitHub release tarball 安装；发布到 npm 是可选项。
- **[codex] 异步子代理** — 基于 mailbox 的 spawn / send_message / followup_task / wait /
  interrupt / close，并有并发上限（`core/src/tools/handlers/multi_agents_spec.rs`）。排在
  "可写子代理"之后。*(L)*
- **[codex] harness 改动的工程约束** — 为模型可见上下文的改动建立审查清单（或 skill），
  约定单次改动行数（≤800 行）和模块大小（≤500 LoC），并要求 agent 逻辑改动附集成测试
  （codex 根目录 `AGENTS.md`、`.codex/skills/code-review-*`）。*(S)*

---

## 附：刻意不借鉴 codex 的部分

仅 Responses API 才有的机制（语法约束的 freeform 工具、远程压缩、WebSocket 增量请求、
`previous_response_id`）在 `hc` 面向的 OpenAI 兼容 Chat Completions 接口上不存在；
规模化基建（Bazel、多平台沙箱后端、网络代理、V8 code mode、实时语音、企业托管配置）与
本项目体量不匹配。
