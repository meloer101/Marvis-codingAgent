# Roadmap — 未完成的工作

> `harness-code`（`hc`）唯一的待办文档，只列**还没做的**。已经能用的功能见
> [`README.md`](../README.md) 和 [`architecture.md`](./architecture.md)，构建历史见 git log。
> 某项做完后直接从本文删除；只做完一部分的，改写成剩余的部分。
>
> 按 harness 分区（A–I）归组。标 **[codex]** 的条目来自 2026-09-14 对
> [`openai/codex`](https://github.com/openai/codex)（`main@f8bed26f`）的源码对照，括号里是可参考的
> codex 文件（路径相对 codex 仓库，省略 `codex-rs/` 前缀）。标 **measure** 的条目要用
> `pnpm eval --ablation` 或真实 Harbor 运行证明效果后才算完成。尺寸：S / M / L。
>
> Last consolidated: 2026-09-23.

---

## 0. 建议顺序

1. **G「失败模式统计」**：先把已有的 18 条 Harbor 轨迹逐条计入 §G 的表，H 节的 measure 项都依赖它。
2. 同时处理下面「待决定」里的问题。

### 待决定（产品取舍，不是工程量）
- **`.env.example` 这类模板文件要不要从敏感文件中豁免？** `isSensitivePath`
  （`packages/core/src/permissions/paths.ts`）对所有以 `.env` 开头的文件名一律拒绝，`read` /
  `edit` / `write` 以及 bash 参数（`cat .env.example`）都会被拒。eval 任务 `edit-env-example-ok`
  已经存在，只等决定。
- **主会话要不要开启 `finalSummaryTurn`？** 最后一回合去掉工具、强制给出总结，目前只有子代理开启
  （`subagents/run.ts`）。决定开启的话，要测量效果。*(S)*
- **能力位覆盖要不要拆回独立的 `capabilities.yaml`？** 目前放在 `.agent/settings.json` 的
  `capabilities` 字段里，拆出来成本很低。

---

## A · Model / Provider

- **工具形态 A/B**（`tools/edit.ts`、`tools/read.ts`）：(a) 参数改成 snake_case
  `file_path / old_string / new_string / replace_all`（dsh 和 Claude Code 都用这套）；(b) `read`
  输出带行号，offset 从 1 开始。指标：eval 任务和 Harbor 子集上的工具错误率、回合数、diff 大小。
  哪一项不赢就不改（改了要重录 cassette）。*(M)* — **measure**
- **DeepSeek strict tools（beta）**：新增 capability `strictTools`，请求改走 `/beta` 根路径，给每个
  function 加 `strict: true`，并从 schema 中去掉 minLength / maxLength / minItems / maxItems（端点不
  支持；`edit.oldString.min(1)` 会被拒）。度量 parseError 率。*(S, 低优先)*
- **[codex] 按模型的 harness 档案**：把 `capabilities.ts` 从"端点能力"扩展为"每个模型的 harness
  行为"，包括工具输出 token 预算、编辑工具形态、提示变体、预算/nudge 文案、自动压缩阈值、可用窗口
  余量（`protocol/src/openai_models.rs`、`models-manager/models.json`）。`hc` 面向的模型强弱差异
  很大，这一项收益最明显。*(M)*
- **原生 Messages（Anthropic 格式）provider**：Claude 现在只能经 OpenRouter 或代理访问。DeepSeek
  也有 `/anthropic` 端点（支持 thinking、tool use、图片，忽略 `cache_control`），dsh 默认走的就是
  Messages 协议，所以一个 provider 能同时服务 Claude 和 DeepSeek。战略价值高，但不是当前优先级。*(M)*

## B · Orchestration loop

- **文本截断后的有限次自动续写**：纯文本的 `max_tokens` 停止已经作为单独的 stop reason 暴露出来，
  但 loop 会直接停下，没有 hermes-agent 那样有次数上限的续写。*(S, 低)*
- **[codex] 回合中途插话（steering）**：运行中也接受用户输入，在下一次模型请求前注入，而不是像现在
  这样由 server 返回 `busy`（`packages/server/src/host.ts`）或被 TUI 忽略。需要
  `AgentSession.steer()`、一个协议方法，以及 TUI / web 输入框的支持（`core/src/session/turn.rs` 的
  `run_turn`）。*(M)*
- **[codex] 兼容 Claude 的命令 hooks**：在 `settings.json` 里按 Claude Code 的 schema 配置 `hooks`
  （PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart / PreCompact；stdin 传 JSON，
  退出码 2 表示阻断，stdout 返回 `permissionDecision` / `updatedInput` / `additionalContext`），
  映射到现有的 `AgentHooks`。要有 `stop_hook_active` 防死循环；hook 输出超过 2.5K tokens 时落盘
  （`hooks/`、`core/src/hook_runtime.rs`）。它也可以作为 H「Stop gate」由用户配置的实现。*(M)*
- **[codex] 流式输出期间提前派发工具调用**：每个 `tool_use` 块一完成，就开始执行已经放行的调用，
  流结束后按模型发出的顺序收集结果，并用读写锁区分能并行和不能并行的工具
  （`core/src/session/turn.rs`、`core/src/tools/parallel.rs`）。只影响延迟，采纳前先测量。*(M)*

## C · Tool system & execution

- **[codex] 后台 shell 进程**：`bash` 增加 `runInBackground`，配套 `bash_output` / `bash_kill`；
  每个会话维护一张进程表（保留首尾输出、有数量上限，中断或关闭会话时全部结束）
  （`core/src/unified_exec/`、`core/src/tools/handlers/shell_spec.rs`）。主要针对 Harbor 上的长时间
  构建和服务类任务。会改变工具列表，需要重录 cassette。*(M)*
- **[codex] MCP `tool_search` 接入 agent loop**：`packages/core/src/mcp/tool-catalog.ts` 已经能把
  MCP 工具分成 inline / deferred（121 个工具的场景下，每回合 18,816 → 4,359 tokens，省 77%），但
  agent loop 还没用上。剩余：
  1. 加载工具：接受查询或工具名，返回完整 schema，把选中的 deferred 工具 `register()` 进 loop 持有的
     `ToolRegistry`，下一次请求生效（codex 用 BM25 检索 deferred 元数据，见
     `core/src/tools/handlers/tool_search*.rs`、`core/src/mcp_tool_exposure.rs`）。
  2. `buildAgentSystemPrompt` 里带开关的 `<available_mcp_tools>` 段，默认关闭，不改变提示字节。
  3. 缓存稳定：清单在会话内字节不变，加载工具只追加（命名空间变化用追加的、有上限的片段通告），
     不改写已缓存的段。
  4. 多 server MCP fixture 的 eval，确认工具选择质量不下降；改变提示的部分单独提交并重录 cassette。
  *(M)*
- **MCP 工具逐个覆盖 `readOnly` / `concurrencySafe`**：MCP 工具目前一律按串行、非只读处理（和
  `bash` 同档）。在 `.mcp.json` 里逐工具覆盖，可以让已知安全的工具并行。目前没有使用方。*(S)*
- **结构化错误覆盖面**：`--output-format json` / `stream-json` 下，早于输出 sink 的错误（比如
  `buildSessionConfig` 深处抛出的未知 provider 名）和顶层 `unhandledRejection` 还是输出纯文本。*(S)*
- **`.env` 按 `process.cwd()` 加载，而不是 `--cwd`**（`packages/cli/src/index.ts` 的 `loadDotEnv`）：
  对另一个目录运行时，读到的是当前目录的 `.env`。*(S, minor)*

## D · Permissions, safety & sandboxing

- **只读 shell 白名单继续扩充**：`READ_ONLY_BASH_COMMANDS` 现在是默认模式下的承重墙，要谨慎、按需地
  扩充。实测里还缺 `sort`（有 `-o` 会写文件，需要排除）和 `for` 循环这类 shell 结构。另外
  `grep -r` 仍会顺带读到 `.env` 的内容，参数检查拦不住。*(S)*
- **[codex] 可解释、可自测的规则**：支持对象形式的规则
  `{ rule, justification?, examples?: { match?, notMatch? } }`。justification 出现在 deny / ask 的
  原因里（包括应该改用什么做法），examples 在规则加载时校验；再提供 `hc permissions check "<cmd>"`，
  输出 JSON 裁决（`execpolicy/README.md`）。*(S–M)*
- **[codex] "始终允许"时提议前缀规则**：从 AST 第一段推导出 `Bash(<prefix>:*)`，而不是放行整个工具；
  拒绝过宽的前缀（`python`、`node`、`sh`、`rm`、heredoc），经确认后写入项目设置
  （`execpolicy/src/amend.rs`、`prompts/templates/permissions/approval_policy/on_request.md`）。*(M)*
- **[codex] 沙箱拒绝后升级重试**：在 `bash` 里识别 `sandbox-exec` 的写入拒绝。交互模式下提供"不带
  沙箱重试"（批准结果在会话内缓存），否则告诉模型失败原因。codex 的流程是：审批 → 选择沙箱 → 执行
  → 升级重试，并允许模型带着给用户看的理由申请升级（`core/src/tools/orchestrator.rs`、
  `core/src/tools/sandboxing.rs`）。*(M)*
- **[codex] 非交互运行的 Guardian 式审阅**：不再把所有 `ask` 一律变成拒绝，而是交给一个隔离的审阅
  模型，按风险政策（数据外泄、凭据探测、持久削弱安全、破坏性操作）裁决，出错时默认拒绝
  （`core/src/guardian/`、`core/assets/guardian/policy.md`）。成本高，要先有专门的 eval。*(L, stretch)*

## E · Context engineering (in-session)

- **压缩请求自身超窗时的重试**：压缩请求（head + 被压缩区间）本身超出窗口时，现在会失败并跳过压缩，
  最后由 loop 的 `context_limit` 停止兜底。codex 的做法是裁掉最旧的一项再重试（`core/src/compact.rs`）。
  *(S)*
- **工具结果修剪（dsh 方式）**：压缩触发后，单条工具结果超过 8192 字符的，只保留头 4096 + 尾 1024。
  先用 ablation 度量再合入。*(S)* — **measure**
- **[codex] 其余状态变化也以追加片段注入**：system prompt 已经按变化段追加，工具列表也已经在模式间
  保持稳定。剩下的是把其他类型化的 "world state" 分区（权限策略、已批准的前缀、工具命名空间）相对
  持久化快照的差异追加进历史，让模型看到当前生效的权限策略（`core/src/context/world_state/`）。
  依赖 I「持久化每回合的上下文记录」，否则 `--resume` 后会失效。*(M)*
- **[codex] 上下文注入规则**：所有模型可见的注入都只追加、每项有上限（单项 ≤10K tokens，超过 1K
  tokens 的要额外审查），并且是带标记的类型化片段（codex 根 `AGENTS.md` 的 "Model visible context"
  一节、`context-fragments/src/fragment.rs`）。落到 `hc`：一个带硬上限的共用片段 helper，加上
  project memory 的**总**预算，并改为按字节截断——`context/memory.ts` 现在每个文件限 32 KiB，但按
  字符截取，CJK 内容会超出。*(S)*
- **[codex] 模型可见的上下文预算**：只提醒一次的剩余 token 提示、`get_context_remaining` 工具、由
  模型发起的 `new_context` 换窗，提示文案按模型配置（`core/src/session/token_budget.rs`、
  `core/src/tools/handlers/get_context_remaining_spec.rs`）。可以替代 H 节推送式的回合预算 nudge。
  *(M)* — **measure**
- **大仓库探索 fixture**：`subagents` 和 `compaction` 两个 ablation 维度在现在的小 fixture 上测不出
  "隔离 / 压缩省上下文"的真实信号，需要一个大仓库探索任务。它也是 Other「可写子代理」的前置条件。*(M)*

## F · Protocol & state sync (web)

- **Markdown 原文显示 bug**：web 渲染器（`Markdown.tsx` / `MarkdownBody.tsx`）有些内容显示成原始
  文本，没有经过净化和高亮渲染。先在当前代码上固定一个确切复现，再找到走原文的回退路径。*(S, 低)*

## G · Observability & evaluation

- **跑完 89 个 Harbor 任务**：已跑 18/89（DeepSeek 余额中途耗尽）。跑完之前，所有能力声明都标注
  **"18/89 provisional"**。卡在预算和时间，不是工程问题。*(L)*
- **失败模式统计**：见下表。下一步是把已有的 18 条 Harbor 轨迹逐条读进表里，让计数是真实的，再在
  上面建任务。
- **eval 多轨迹回放**：一份 cassette 里有两条以上轨迹时回放不了，所以 `plan-then-implement` 只能
  `runs: 1`，统计力很弱。*(S)*
- **[codex] 可选的全量调试包**：只在开启时，写出有序的原始事件和精确的请求 / 响应内容，离线还原每次
  请求"模型实际看到了什么"（`rollout-trace/README.md`）。能方便 Harbor 事后分析和 H 节的测量；
  默认 trace 仍不含正文。*(M)*
- **[codex] 带生命周期阶段的特性开关注册表**：类型化的开关（开发中 / 实验 / 稳定 / 弃用 / 已移除），
  每个行为改动都放在开关后面，ablation 可以统一切换（`features/src/lib.rs`）。*(S–M)*
- **OpenTelemetry exporter**：基于现有 trace 事件的 span / metric 导出。*(M, stretch)*
- **DeepSeek effort 档位的实际折叠**：单次采样的 reasoning token 数在各档之间没有单调关系，要多次
  重复、取中位数，才能判断 minimal / xhigh 实际折叠到哪一档（`scripts/deepseek-probe.mjs`）。不影响
  `mapEffort` 现在的保守映射。*(S, 低)*

### 失败模式统计

决定下一步做什么的依据，方法见 [EVALS.md](EVALS.md)。**怎么记：** 跑 `pnpm eval --analyze <results>`
（或读 `evals/harbor/summarize.py` 列出的 Harbor trace），每条运行只记*第一个*出错的地方，计入已有
的行或新开一行；按**不同的轨迹**计数，同一份 cassette 回放三次只算一条。修好并测过的行直接删除。

状态：`observed` → `task/grader exists` → `fix landed` → `fix measured`（成对 CI 不含 0）或
`fix unproven`。

| # | 失败模式 | 第一个错误的样子 | 计数 | 证据 | eval 信号 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | `.env.example` 被当成密钥 → 过度拒绝 | 对 `.env.example` 的 `read`/`edit`/`write` → `deny: Refusing to access sensitive file` | 引擎探针（确定性）；真实通过率未测 | `isSensitivePath` 匹配所有以 `.env` 开头的文件名，这是有意的（README 安全一节列了 `.env*`） | 任务 `edit-env-example-ok`（capability） | 任务已有，等 §0 的决定 |
| 3 | 简单问题上过度工程 | 能直接算的地方写了一个通用求解器（`largest-eigenval`） | 未从 trace 逐条统计 | Harbor 18/89 | grader `diff-size`；还缺一个由 trace 派生的小 capability 任务 | fix landed, unproven |
| 4 | 交付物投入过晚 | 第一次写真正的输出之前，做了很多轮探索或 scratch 工作 | 未统计 | Harbor 18/89 | grader `first-touch` | fix landed, unproven |
| 5 | Scratch 文件蔓延 | 工作区里留下辅助和调试文件 | 未统计 | Harbor 18/89 | grader `scratch-sprawl` | fix landed, unproven |
| 6 | 回合预算 nudge 伤害迭代 / 优化类任务 | 需要反复尝试的任务过早收尾 | 净 +2/−1 | Harbor 18/89 | nudge 开关做好后用 `--ablation`；需要一个优化类 capability 任务 | observed |

## H · Agentic behavior quality

下面几项的 prompt 修复都已合入（`AGENT_CONVENTIONS` 的 `<working_style>` 块等），对应的 grader 也有了，
缺的是**测量**：本地 fixture 复现不了多次尝试 / 优化类的失败，需要真实 Harbor 重跑或专门的 eval 任务。
计数见上面的失败模式表。

- **回合预算 nudge 按任务形态调节**：现在是 60% / 80% / 最后一回合三级 nudge
  （`AgentLoop.turnBudgetNote`）。剩余：根据任务形态信号（比如 todo 里的重复迭代模式）有条件地减弱或
  关闭 nudge；先给 nudge 加开关，再做 ablation。*(M)* — **measure**
- **接近预算上限时的收尾文案**：加上明确的"停止打磨、交付当前状态"文案，并考虑超过 90% 后单独进入
  强制收尾模式，针对"纠结细枝末节"的症状。*(S–M)*
- **验证"简单优先"**：在 Harbor 上验证它能不能挽回 `largest-eigenval` 这类任务（表中 #3）。*(M)* —
  **measure**
- **验证"尽早动交付物"和 scratch 约定**：用 `first-touch` / `scratch-sprawl` 在真实运行上测（表中
  #4、#5）；只靠 prompt 不够时，再做结构化方案（harness 强制的 scratch 目录）。*(S–M)* — **measure**
- **Stop gate 的真正使用方**：`onBeforeStop` hook 和续跑上限都有了（`agent/hooks.ts`、
  `agent/loop.ts`），缺一个在模型宣布完成前核验验收标准的实现（参考 hermes-agent 的
  `verification_stop`），也可以由 B 节的命令 hooks 提供。*(M)*
- **纯 reasoning 轮的重发提示**：DeepSeek 偶尔只返回 reasoning、没有正文和工具调用。先在遥测里看出现
  频率，再决定要不要默认追加一条 ephemeral 提示重发。*(S)*

## I · Operational hardening

- **[codex] 持久化每回合的上下文记录**：会话日志现在只存消息。codex 还持久化回合上下文、world-state
  快照和压缩标记，resume / fork 时能精确还原模型可见的布局和设置（`rollout/src/policy.rs`、
  `core/src/session/rollout_reconstruction.rs`）。这是 E「其余状态变化也以追加片段注入」在
  `--resume` 后依然有效的前提。*(S–M)*

## TUI v1.1

- 代码块语法高亮（`cli-highlight`），v1 只是调暗显示。
- Markdown 表格（v1 按纯文本显示）。
- OSC-11 自动检测浅色主题 + `/theme` 持久化（浅色配色已接好，但 v1 只发布了深色，也不会自动切换）。
- 自己写的多行编辑器（缓冲区内光标移动）+ 输入历史。
- 按工具卡片逐个聚焦导航（v1 只有一个全局的"展开最后一次输出"开关）。
- 运行中切换 `/model`（v1 只读显示）；更丰富的 `/mcp` `/skills` 浮层。
- Windows 打磨（老控制台回退到 REPL；cmd.exe 下的 TUI 标为不支持）。

## Other

- **可写子代理**：`explore` 的只读隔离已验证有效；未声明 `tools` 的自定义 agent 会继承父级的写工具。
  剩余：内置并验证过的可写子代理，以及并发安全——`task` 标为 `concurrencySafe`，多个会写文件的子代理
  并行时可能互相冲突。等 E「大仓库探索 fixture」验证隔离收益之后再做。*(M)*
- **[codex] 异步子代理**：基于 mailbox 的 spawn / send_message / followup_task / wait / interrupt /
  close，带并发上限（`core/src/tools/handlers/multi_agents_spec.rs`）。排在可写子代理之后。*(L)*
- **`hc eval` 命令**：对 `evals/dist/cli.js` 的 `child_process.spawn` 包装（故意不 import，让
  fixture 和 cassette 不进 `hc` 二进制）。`pnpm eval` 已经有了，这只是补一个 CLI 动词。*(S)*
- **eval harness 迁移到 `AgentSession`**：`evals/src/harness.ts` 还在用自己的无头精简版循环。合并能
  去掉重复，但有风险：cassette 按请求指纹匹配，必须和 `buildAgentSystemPrompt` 逐字节一致，否则要全部
  重录。单独提交，一旦漂移就回滚。*(M)*
- **`npm publish`**：目前通过 GitHub release tarball 安装，发布到 npm 是可选项。
- **[codex] harness 改动的工程约束**：为模型可见上下文的改动建立审查清单（或 skill），约定单次改动
  行数（≤800 行）和模块大小（≤500 LoC），并要求 agent 逻辑改动附集成测试（codex 根目录 `AGENTS.md`、
  `.codex/skills/code-review-*`）。*(S)*

---

## 明确不做

- **DeepSeek**：不发送 dsh 的 `x-deepseek-harness-*` 头和 `dsh_session_log`（那是 DeepSeek 自家遥测）；
  不设置 `user_id`（会把缓存分区）；不切 Responses API；不引入 DeepSeek tokenizer（现有
  `createTokenCalibrator` 用真实 usage 校准已经够用）。
- **codex**：只有 Responses API 才有的机制（语法约束的 freeform 工具、远程压缩、WebSocket 增量请求、
  `previous_response_id`）在 `hc` 面向的 Chat Completions 接口上不存在；规模化基建（Bazel、多平台
  沙箱后端、网络代理、V8 code mode、实时语音、企业托管配置）和本项目体量不匹配。
- **跨会话记忆**：不做语义检索、自动去重合并、跨机器同步。
