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
> Last consolidated: 2026-09-25.

---

## 0. 建议顺序

1. **H「测量"完成前核验"」**：已经实现，差一次实测（需要 DeepSeek 余额，capability 任务约几毛钱）。
2. **G「Harbor 的 `max_turns` 40 是不是太紧」**：3 个大任务到第 40 轮还没做完（#14）。便宜的实验，见 G 节。
3. **H「按"没有进展"触发的 step-back 提示」**：9 月上旬最多的失败（#7）。9 月下旬没出现在第一个错误里，但仍在。

### 待决定（产品取舍，不是工程量）
- **`.env.example` 这类模板文件要不要从敏感文件中豁免？** `isSensitivePath`
  （`packages/core/src/permissions/paths.ts`）对所有以 `.env` 开头的文件名一律拒绝，`read` /
  `edit` / `write` 以及 bash 参数（`cat .env.example`）都会被拒。eval 任务 `edit-env-example-ok`
  已经存在，只等决定。
- **主会话要不要开启 `finalSummaryTurn`？** 最后一回合去掉工具、强制给出总结，目前只有子代理开启
  （`subagents/run.ts`）。决定开启的话，要测量效果。*(S)*
- **项目里的会话和 trace 要不要也移出仓库？** 现在只有"不是项目的目录"写到 `~/.agent/projects/`；在项目里仍写
  `<项目根>/.agent/{sessions,traces}`。本仓库的 `.gitignore` 忽略了它们，但别人的仓库不一定，`git add -A` 会把
  会话日志（含工具输出）提交进去。Claude Code 和 codex 都把这类状态放在 home 下。改的话要让 `--resume`、`hc trace`、
  `hc stats`、TUI 和 web 的会话列表同时读新旧两个位置。*(S–M)*
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
  （`hooks/`、`core/src/hook_runtime.rs`）。`Stop` hook 也能让用户在内置的完成前核验（`agent/verify-stop.ts`）之外，接上自己的验收脚本。*(M)*
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

- **无法审查的命令在 `ask` / `acceptEdits` 下改为交给人确认**：`$(...)`、heredoc、`python -c` 这类命令，
  `yolo` 下已经放行（9-25），其他模式仍然直接拒绝。在有人审批的模式下，把它们交给人看比直接拒绝更合理：用户
  能读懂整条命令，而拒绝只会让模型绕路写文件。`auto` 模式可以交给分类器。*(S)*
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

- **补齐 Terminal-Bench 全量的 18 个作废任务**：9 月下旬 `deepseek-flash` 全量运行有效 71/89、通过 53
  （75%），其余 18 个作废（欠费 8、Mac 睡眠 3、基础设施 7，名单见 §G 失败模式统计）。欠费和睡眠的 11 个补跑约
  ¥2；基础设施的 7 个多半要换 x86 / 云端沙箱（`--env daytona/modal`）才跑得起来。能力声明写"71/89 有效、
  各跑 1 次"。另外，每个任务只跑了 1 次，要看稳定性得多跑几次（全量一次约 ¥12）。
  *(M)*
- **Harbor 的 `max_turns` 放宽实验**：adapter 默认 `--max-turns 40`，而 Terminal-Bench 只限墙钟。9 月下旬
  有 3 个大任务（MIPS 解释器、MIPS 上的 Doom、细胞分割）到第 40 轮还在修 bug（#14）。用 `--ak max_turns=100`
  重跑这几个任务，看是回合上限卡住了还是本来就做不出来；同时留意更多回合会不会让其他任务"做完不停"（#8）。
  *(S)* — **measure**
- **失败模式统计**：见下表。每次 Harbor 运行后用 `evals/harbor/digest.py` 逐条读、更新计数。
- **eval 多轨迹回放**：一份 cassette 里有两条以上轨迹时回放不了，所以 `plan-then-implement` 只能
  `runs: 1`，统计力很弱。*(S)*
- **eval 里单次请求出错不该中断整批运行**：一次 `ProviderError`（比如 Mac 睡眠导致流式超时）会让整个
  `pnpm eval` / `--ablation` 直接退出，已经跑完的运行也拿不到报告。应该把这次运行记为出错（不计入通过率，
  像 Harbor 的 infra 一样单独列出），然后继续跑其余的。长时间的 live 运行还要防睡眠：在电池上合盖时
  `caffeinate` 也挡不住。*(S)*
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

决定下一步做什么的依据，方法见 [EVALS.md](EVALS.md)。**怎么记：** 跑 `pnpm eval --analyze <results>`，
或对 Harbor 结果跑 `python3 evals/harbor/digest.py <jobs_dir>`（逐轮时间线，读的是 trial 的
`agent/hc-sessions/`）。每条运行只记*导致结果出错的第一个*错误，计入已有的行或新开一行；按**不同的轨迹**
计数，同一份 cassette 回放三次只算一条。后面才出现的错误记在"之后"一列，不计数。不影响结果的摩擦
（权限拒绝、工具 bug）单独记在第二张表。修好并测过的行直接删除。

状态：`observed` → `task/grader exists` → `fix landed` → `fix measured`（成对 CI 不含 0）或
`fix unproven`。

**两次运行：**
- **9-23/24 全量**：`deepseek-flash`，Terminal-Bench 2.0 全部 89 个任务各跑 1 次（先跑 18 任务子集，再跑其余
  71 个；第二批多了一个 `grep` 修复，其他版本相同），本地 Docker（Apple M4 + Rosetta，
  `--agent-timeout-multiplier 2`）。**有效 71 个，通过 53 个 = 75%**。另外 18 个不计入：DeepSeek 余额耗尽
  8 个，Mac 睡眠 8 小时期间被判超时 3 个（`install-windows-3-11`、`rstan-to-pystan`、`mteb-leaderboard`），
  基础设施错误 7 个（环境启动超时 4、adapter 安装时 `apt-get` 失败 2、判分超时 1）。留出集 13/13 通过（另有
  2 个作废），其余任务 40/58。花费约 ¥12.4（$1.7）。18 个 agent 失败逐条读了完整对话（留出集没有失败）。
  轨迹在 `evals/harbor/.jobs/2026-09-23__11-37-38/` 和 `…/2026-09-24__15-53-27/`（gitignore，只在本机）。
- **9-08/09**：`deepseek-v4-pro`，18 任务子集，29 条轨迹（基线 18 条 + nudge 重跑等），原始轨迹已丢失，计数
  是从当时的两份分析文档重建的（`docs/harbor.md` @ `9c5f788`、`docs/eval-findings.md` @ `acd23a3`），4 条
  失败没有记录原因。

两次模型不同，通过率不能直接比；每个任务都只跑 1 次，计数只能看方向。

| # | 失败模式 | 第一个错误的样子 | 9 月下旬计数 | 9 月上旬计数 | 之后（不计数） | eval 信号 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | 验证不到位就宣布完成：只验证了自己做的东西，或者根本没能运行交付物 | 输出对了但漏了题目明写的 `:wq` 结尾（`large-scale-text-editing`）；只用一个干净文档测"不误改"（`filter-js-from-html`）；接口和调用方不符（`adaptive-rejection-sampler`）；环境里没有 SPARQL 引擎，"手工核对"后交了一个有语法错误的查询（`sparql-university`）；在自己切的验证集上 0.6243、刚过 0.62 的线就停，实际 0.617（`train-fasttext`）；Tm 算的区域和判分不一致（`dna-assembly`）；自测没覆盖到的走法（`regex-chess`，44/45）和矩阵行（`model-extraction-relu-logits`） | **8** | 0 | — | capability 任务 `verify-stated-requirements`、`verify-clean-input-unchanged`；`--ablation verify-stop` | fix landed（9-25，`agent/verify-stop.ts`）, unproven |
| 13 | 笃定地给出错误的结论或解释 | 把"打印出来的是什么文字"答成"根本没有文字"（`gcode-to-text`）；光谱 x 轴在 1648–47183、明显不是 cm⁻¹，却用"G/2D 比值对得上"圆过去（`raman-fitting`）；认定题目示例"只是示意"，按自己推测的加载基址输出，匹配 0%（`extract-elf`） | **3** | 0 | `extract-elf` 去 grep `/opt/hc/hc.mjs` 找"参考答案" | — | observed |
| 14 | 40 轮上限内做不完的大任务 | 写 MIPS 解释器、为 MIPS 编译 Doom、细胞分割，到第 40 轮还在修 bug，交付物停在坏掉的状态（`make-mips-interpreter`、`make-doom-for-mips`、`sam-cell-seg`） | **3** | 0 | — | — | observed。40 是 adapter 的默认 `max_turns`，Terminal-Bench 本身只限墙钟，见 G 节 |
| 15 | 重任务在 Rosetta 下超出墙钟（环境限制，不是 agent 行为） | 装依赖 24 分钟、跑 OCR 19 分钟（`caffe-cifar-10`、`extract-moves-from-video`） | **2** | 0 | — | — | 换 x86 / 云端沙箱后再看 |
| 3 | 简单问题上过度工程 | 不先交一个 numpy 版，而是去 scipy、LAPACK、装 gcc、手写 C 内核（`largest-eigenval`，最后速度还差一点没过线） | **1** | 3（同一任务） | `eigen.py` 第 28/39 轮才第一次写（#4） | grader `diff-size`；还缺 capability 任务 | fix landed（"先试简单方案"规则），**9 月下旬在同一任务上重现，属于反证** |
| 11 | 探查时破坏了不可再生的输入 | 第 2 轮直接 `sqlite3 main.db ".tables"`，SQLite 因 WAL 头部无效把被加密的 WAL 删了（`db-wal-recovery`） | **1** | 0 | 之后 20 轮在 `/proc`、块设备、harness 自己的日志里找（#7） | — | observed |
| 7 | 钻牛角尖：一条错的路越走越深，命令都成功，只是方向错 | 手写一个又一个 XSS 变体；翻 `/proc`、手工模拟 WAL；下载棋子图片 | 0 | 3 | 1（`db-wal-recovery`） | 还没有 | observed。现有 step-back 提示（`stallNote`）只在连续 3 轮工具调用**全部失败**时触发，覆盖不到，见 H 节 |
| 8 | 做完了不停，跑到回合上限 | 任务已经能通过，仍继续打磨直到 40 轮 | 0 | 2 | — | 回合数 | fix landed（turn-budget nudge）；9 月下旬到 40 轮的 3 条都是没做完（#14），不是做完不停 |
| 4 | 交付物投入过晚 | 第一次写真正的输出之前，做了很多轮探索或 scratch 工作 | 0 | 1 | 1（`largest-eigenval`） | grader `first-touch` | fix landed, unproven |
| 6 | 回合预算 nudge 伤害迭代 / 优化类任务 | 优化类任务在 nudge 下锁定已选的复杂方案 | 0 | 1 次翻转 | — | 需要 nudge 开关和优化类 capability 任务 | observed |
| 2 | `.env.example` 被当成密钥 → 过度拒绝 | 对 `.env.example` 的读写被拒 | 0 | 0 | — | 任务 `edit-env-example-ok` | 任务已有，等 §0 的决定 |
| 9 | 盲目重试同一条失败命令 | — | 0 | 0 | 0 | 工具错误数 | fix landed（step-back 提示）, unproven |
| 5 | Scratch 文件蔓延 | 工作区里留下辅助和调试文件 | 0 | 0 | 多条都建了多个 scratch 文件，但**结束前基本都清理了**；有几条的清理被权限引擎拒绝（见下表） | grader `scratch-sprawl` | fix landed；"结束前清理"生效，"复用同一个文件"没有 |
| 10 | 快到上限时纠结细枝末节 | — | 0 | 0 | 0 | — | observed |

**摩擦（不直接导致失败，但每条都在浪费回合），9 月下旬全量的 70 条有效轨迹：**

| 摩擦 | 涉及轨迹 | 次数 | 说明 |
| --- | --- | --- | --- |
| `yolo` 模式下权限引擎硬拒绝合法命令 | **68/70** | 209 次，占全部 2075 次工具调用的 10.1% | `python -c` 91 次（48 条）、heredoc 解析不了 35 次（28 条）、`$(...)` 36 次（23 条）、`write` 写工作区外（`/tmp`）28 次（22 条）、管道到 `sh` 10 次、递归删除工作区内的目录 6 次（包括 agent 自己的 `scratch/`）。每次基本都要多花一轮改写。**9-25 已放宽**：`yolo` 下放行内联代码、`$(...)`、heredoc；文件工具可以读写系统临时目录；删除工作区内的目录不再被拒。管道到 shell 和其他破坏性命令仍在所有模式拒绝。下次 Harbor 运行时验证 |
| 翻 harness 自己的文件（`.agent/`、`/opt/hc`、`/logs/agent`） | 12/70 | — | `hc` 把 `.agent/` 写在任务目录里，agent 一 `ls` 就看到；有的去翻自己的日志，有的去 grep `hc.mjs` 找"参考答案"。**9-25 已修**：不是项目的目录改写到 `~/.agent/projects/`，Harbor adapter 用 `HC_STATE_DIR` 把状态直接写进日志目录。下次 Harbor 运行时验证 |
| `grep` 工具的 `path` 指向单个文件时报 `ENOTDIR` | 1（第一批） | 2 次 | 容器里没有 `rg`，JS fallback 把文件路径当目录用。**已修复**，第二批没有再出现 |

## H · Agentic behavior quality

下面几项的 prompt 修复都已合入（`AGENT_CONVENTIONS` 的 `<working_style>` 块等），对应的 grader 也有了，
缺的是**测量**：本地 fixture 复现不了多次尝试 / 优化类的失败，需要真实 Harbor 重跑或专门的 eval 任务。
计数见上面的失败模式表。

- **按"没有进展"触发的 step-back 提示**：失败模式 #7（钻牛角尖，3 个任务）的命令大多是成功的，而现有的
  `stallNote` 只在连续 3 轮工具调用全部失败时触发，所以从来不会提醒。新增一个进展信号，例如连续 M 轮没有
  改动任何与任务相关的文件、或反复在同一类探索命令上打转时，注入"当前方向没有收敛，最简单能通过的做法是
  什么"。放在开关后面，先写一个"方向错但命令都成功"的 capability 任务来测。*(M)* — **measure**
- **回合预算 nudge 按任务形态调节**：现在是 60% / 80% / 最后一回合三级 nudge
  （`AgentLoop.turnBudgetNote`）。剩余：根据任务形态信号（比如 todo 里的重复迭代模式）有条件地减弱或
  关闭 nudge；先给 nudge 加开关，再做 ablation。*(M)* — **measure**
- **接近预算上限时的收尾文案**：加上明确的"停止打磨、交付当前状态"文案，并考虑超过 90% 后单独进入
  强制收尾模式，针对"纠结细枝末节"的症状。*(S–M)*
- **"简单优先"没有起作用**：9 月下旬的 `largest-eigenval` 又一次先去装 gcc、写 C 内核，没有先交 numpy 版本
  （表中 #3）。只靠 prompt 规则不够；可以考虑结构化做法，例如在优化类任务上要求先有一个能通过正确性测试
  的基线交付物，再允许优化。先从这条轨迹派生一个 capability 任务。*(M)* — **measure**
- **"尽早动交付物"和 scratch 约定**：9 月下旬的轨迹里，"结束前清理 scratch 文件"基本都做到了，"复用同一个
  scratch 文件"没有（`gcode-to-text` 建了 12 个）；`largest-eigenval` 仍是第 28/39 轮才第一次写交付物（表中
  #4、#5）。*(S–M)* — **measure**
- **测量"完成前核验"**：`agent/verify-stop.ts` 已实现（9-25）：本轮动过 `write`/`edit`/`bash` 的任务在第一次
  宣布完成时，被送回去逐条对照用户原文的要求给出证据，每个任务最多一次。一次性的 `hc agent` 默认开启，交互式
  会话默认关闭（设置 `verifyBeforeStop`）。还没测：用 `pnpm eval --suite capability --ablation verify-stop
  --runs 5` 在两个从 #12 派生的任务（`verify-stated-requirements`、`verify-clean-input-unchanged`）上做成对
  比较，再在下次 Harbor 运行里看 #12 的计数和多出来的回合成本。*(S)* — **measure**
- **动手前先备份不可再生的输入**：`db-wal-recovery`（表中 #11）第 2 轮就用 `sqlite3` 打开数据库，导致被
  加密的 WAL 被删除，之后无法恢复。在 `<working_style>` 里加一条：对恢复、取证类任务，先复制原始文件再用
  可能修改它的工具去探查。*(S)* — **measure**
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
