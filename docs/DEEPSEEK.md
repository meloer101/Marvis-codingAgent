# DeepSeek 深度适配：调研结论与实施方案

> 状态：P0（正确性）已落地 2026-09-18，P1 / P2 待实施。调研日期 2026-09-16。
> 本文回答两个问题：DeepSeek API 和 DeepSeek 自家 harness（dsh）现在长什么样；`hc` 在"模型在乎的层"
> 上和它们差在哪里、按什么顺序补。完成的条目请从本文删除并同步到 [`ROADMAP.md`](./ROADMAP.md)。

## Context

绝大多数实际使用走的是 DeepSeek 的 flash API，目标是让 harness 在"模型在乎的层"（工具形态、编辑格式、
system prompt 约定、API 调用方式）贴着 DeepSeek 走，把差异化留在权限、协议、多前端这些模型"不在乎"的层。

调研对象：DeepSeek 官方 API 文档（2026-09 现状）、DeepSeek 自家开源 harness
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（dsh，2026-08-13 发布）、
以及社区在 V4 上踩过的坑。

仓库现状：`packages/core/src/provider/openai-compat.ts` 是唯一的 provider 实现，DeepSeek 已是默认模型和
eval 模型，但有几处假设已经过时，其中一处会直接导致带工具的多轮请求 400。

---

## 一、调研结论

### 1. DeepSeek API 2026-09 现状（一手来源：api-docs.deepseek.com）

下表"仓库现状"一列记录的是 **P0 落地之前**的状态，保留下来是为了说明每条结论从哪来。


| 项目 | 现状 | 仓库现状 |
|---|---|---|
| 模型 id | `deepseek-flash`（V4.1-Flash，09-10 发布，1M ctx / 384K out，原生视觉，默认开 thinking）；`deepseek-v4-pro`（09-14 后继续提供）；`deepseek-v4-flash` 临时路由到 V4.1-Flash | 默认 `deepseek-v4-flash`；`deepseek-flash` 不命中任何规则，退化成 128K/8K/无 reasoning（`capabilities.ts` 的 `PROVIDER_DEFAULTS`） |
| thinking 开关 | `thinking: {type: enabled\|disabled}`；effort `reasoning_effort: low\|high\|max`（默认 high）；**不接受** minimal/medium/xhigh（dsh 客户端直接拒绝） | `capabilities.ts` 顶部注释声称"服务端会折叠整条梯子"，并把 6 档全发出去 |
| **reasoning_content 回传** | 调研当时的结论是"带 `tools` 时必须原样回传，否则 400"。**2026-09-19 实测推翻**（§四 §1 第 1 项）：回传和省略都是 200 | `toOpenAIMessages` **主动丢弃** thinking（R1 时代的规则，现在反了）；纯 reasoning 轮整条被跳过 |
| assistant content | 纯工具调用轮官方样例回传 `""`；`content: null` 且无 tool_calls 会 400 | 空文本发 `null` |
| thinking 模式下 | temperature / presence / frequency 无效（不报错）；top_p 下限 0.95；`tool_choice: "required"` 400，`none` / 指定函数可用 | 无影响，但 compactor 传 `temperature: 0` 是无效参数 |
| max_tokens | 默认 8K（非 thinking）/ 64K（thinking）/ 128K（max）；上限 384K | `OUTPUT_RESERVE_CEILING = 64K` 合理 |
| 缓存 | 自动前缀缓存；缓存单元在"用户输入结束 / 模型输出结束 / 定长间隔"处建立，需完全匹配；`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；TTL 数小时到数天；`user_id` 会**分区**缓存（不要按会话设） | 已读 `prompt_cache_hit_tokens` |
| 定价（$/M，峰/谷） | flash：miss 0.30/0.15，**hit 0.006/0.003**，out 1.20/0.60；pro：miss 1.32/0.66，hit 0.044/0.022，out 3.96/1.98。峰时 = 周一至五 01:00–04:00、06:00–10:00 UTC（北京 09–12、14–18） | flash 占位价 0.44/0.11/1.32，pro 1.32/0.33/3.96：**缓存命中价高估约 20–50 倍**，成本闸门和遥测都不准 |
| 限流 / 负载 | 并发上限 flash 2500 / pro 500 → 429；高负载时非流式返回空行、流式返回 `: keep-alive` 注释；10 分钟内未开始推理则断开；402 = 余额耗尽 | 总超时 600s 而非空闲超时；402 走 `unknown` |
| 严格模式 | `strict: true` + base_url `/beta`；不支持 minLength/maxLength/minItems/maxItems | 未用；`edit.oldString.min(1)` 会被拒 |
| 长上下文质量 | MRCR 8-needle 256K 内 ≥0.82，1M 时 0.59；DeepSeek 给 Claude Code 的建议是 768K 自动压缩、effort max | 压缩阈值按 1M 的 92% 算，约 861K |
| 已知故障 | V4/V4.1 在长上下文（约 95K+）或工具多（约 40 个）时，偶发把工具调用以**纯文本**吐进 content（DSML 标记 `<｜DSML｜invoke name="…">` / V4.1 加空格的 `<｜DSML｜ invoke …>`，或 `toolname{json}` 裸格式），`finish_reason=stop`、`tool_calls=null` | 会把这些原样当正文显示，然后回合结束 |
| Anthropic 兼容端点 | `https://api.deepseek.com/anthropic`，支持 thinking / tool use / 图片，忽略 cache_control | 无 |

### 2. DeepSeek 自家 harness（dsh）的选择："第一方 harness 长什么样"

- **协议**：dsh 默认走 **Messages（Anthropic 格式）**，Chat Completions 是备选；Chat 路径下 `reasoning_content` 只要非空就回传，"无论那轮有没有调工具"。
- **序列化**：assistant `content` 永远是 `""` 不是 `null`；`off` 用 `thinking.type=disabled` 表达，不把 `off` 当 effort 发上去；`temperature` 照发。
- **流解析**：首个空 reasoning delta 不开块；`finish_reason` 和 usage 推迟到 `[DONE]`；没有 `[DONE]` 就当截断报错；`stop` 且零内容 = `EMPTY_RESPONSE`，**默认重试**；`insufficient_system_resource` 等未知 finish 当错误。
- **重试**：EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT 各 5 次，500ms→10s 指数退避 + 10% 抖动，尊重 Retry-After；空闲超时 300s。
- **默认值**：maxTokens 256K；上下文 1M；effort high。
- **缓存友好的 system prompt 更新**（`systemPromptUpdate: in-history`，`deepseek-flash` 声明）：会话中 system prompt 变了，**不改写头部**，而是在已缓存的历史之后追加一条新的 `system` 消息，端点以最后一条 system 为准，前缀缓存不失效。工具 schema 变化仍会从第一个变化的 token 起失效。
- **压缩**：阈值 0.8，保留最近 16%；摘要请求**原样重放 system + tools + 被压缩区间的消息**，最后追加一条压缩指令，因此摘要请求几乎全部命中缓存；摘要以 `user` 消息插入，带 `<compacted-summary>` 标签和固定的 Markdown 结构；工具结果修剪：>8192 字符 → 头 4096 + 尾 1024，只在压缩触发后执行；溢出（CONTEXT_WINDOW_EXCEEDED）后最大化压头部再重试一次。
- **工具**：`tool-fs` 的 `read`（带行号，offset 1-based，limit 2000）/`write`/`edit`（`file_path, old_string, new_string, replace_all`，"snake_case 以对齐 Claude Code"）；备选 `str_replace_editor`（view/create/str_replace/insert）；Minimal 档只有 `bash + str_replace_editor`。工具结果空输出发 `(no output)`（和本仓库一致）。

### 3. 结论

1. **仓库对 DeepSeek 的三条假设已经过时**：丢弃 reasoning（会 400）、effort 梯子服务端折叠（会被拒）、定价（缓存价高估几十倍）。这是 P0。
2. **成本大头不是 token 数而是缓存命中率**：flash 缓存命中价是未命中价的 1/50。所有会打断前缀的行为（system prompt 中途改写、工具列表变化、压缩摘要用全新 prompt）都值得按 dsh 的做法修。
3. **工具形态**：本仓库的 `edit` 和 dsh 的 `edit` 语义一致，只差参数命名（camelCase vs snake_case）。是否对齐要用 eval 度量，不盲改。
4. dsh 默认 Messages 协议，但 Chat Completions 是官方完整支持的路径。**本方案留在 Chat Completions**；原生 Messages provider 是 ROADMAP §2 A 已有条目，将来可同时服务 Claude 和 DeepSeek。

---

## 二、方案（三档，按序落地）

### ~~P0 · 正确性~~ — 已落地（2026-09-18）

P0-1/P0-2/P0-3 已实现并有单测覆盖，本节其余内容已删除。**没做的三件事**，理由各异：

- **在无 thinking 的 assistant 轮上主动补 `reasoning_content: ""`** —— 探针（§四 §1 第 2 项，
  2026-09-19）已回答：省略字段完全没问题，**不需要**注入，维持现状。同一轮探针还推翻了本文
  P0-1 的前提——不回传也不会 400（第 1 项）——所以 `REASONING_REPLAY_REQUIRED` 自愈现在是
  保险而非必需；回传本身保留，理由改为"和 dsh 一致 + 前缀与缓存字节一致"。
- **纯 reasoning 轮的 ephemeral 重发提示** —— 按原计划先在遥测里看频率，未默认开启。
- **eval 任务的模型 id** —— `evals/tasks/*/task.json` 仍是 `deepseek-v4-flash`：cassette 的请求
  指纹包含模型 id，改名等于全部失配。留到 P1 重录 cassette 时一起改（重录本身仍是必须的：
  出站消息里现在多了 `reasoning_content`，录制内容已经变了）。

自愈逻辑和 `reasoningReplay` 一旦被实测推翻，改动集中在 `openai-compat.ts` 的
`requestCompletion` / `toOpenAIMessages` 两处。


### P1 · 成本与缓存 — 已全部落地（P1-2/3/4 2026-09-18，P1-1 2026-09-19）

**P1-1 system prompt 的 in-history 更新 —— 已完成（2026-09-19），实现与原方案有一处关键出入**
- 新 capability `systemPromptUpdate: 'rewrite' | 'in-history'`，DeepSeek 全系设 `'in-history'`；`ModelRequest.systemUpdate` 是"要生效但不许动头部"的那段文本，provider 把它放在历史倒数第一条消息之前发出（探针 3 验证过的形状）。`AgentSession` 记住本会话首次发出的 system 段（`#sessionSystem`），之后每回合只算差异。
- **与原方案的出入**：原方案写"追加一条完整的新 prompt"。探针 6 实测这样**更贵**——正文在上下文里被复制一份，短历史下比直接改写头部还贵 2.8 倍。改为只追加**变化的段**（`agent/system-update.ts` 的 `systemUpdateSegments`）：短历史比改写省约 2 倍，长历史省约 11 倍。消失的段（退出 plan 模式）用一句话明确作废，探针 7 验证模型两个方向都照做。
- 工具列表稳定性：`exit_plan_mode` 改为会话内始终注册，非 plan 模式由 permission engine 拒绝并说明原因（"这不是 plan 模式，直接动手做"）。工具列表因此不再随模式变化。
- **已在 eval 里度量**（2026-09-19）：新任务 `plan-then-implement`（plan → 批准 → 实施两个回合）加上 `pnpm eval --task plan-then-implement --ablation system-update`。切换模式之后那一次请求的缓存命中：**只发变化段 98.2%（9344/9516）对 改写头部 13.3%（640/4800）**；整轮 94.9% 对 79.7%。两条轨迹本身不同，所以看比率不看总量。

**P1-2 压缩器复用暖前缀** —— 已完成：`TurnContext` 现在带上本回合请求的 `system` / `tools`，压缩请求 = 同一组 system 段 + 同一份 tools + `[head..middle]` 原样消息 + 末尾一条压缩指令，`toolChoice: 'none'`、`reasoningEffort: 'low'`、去掉无效的 `temperature: 0`。仅当 summarizer 就是会话模型时启用（`warmPrefix`），否则走原来的扁平 prompt。`contextBudgetTokens` 已加：DeepSeek 声明 `qualityContextWindow: 256K`，warn/compact/stop 按它算，硬窗口仍是 1M。**剩余**：工具结果修剪改成 dsh 式"单条 >8K 字符 → 头 4K + 尾 1K"，按原计划要先 ablation 度量。

**P1-3 effort 传递** —— 已完成：`RunSubagentOptions.reasoningEffort`，agent 定义可写 `effort:`（`explore` 已设 low），session-runner 按"定义优先、否则继承会话"转发；eval harness / task.json 透传 effort；压缩器用 low，auto-mode 分类器用 low。

**P1-4 超时与保活** —— 已完成：600s 变成"首字节前 600s + 空闲 300s"，`parseSSE` 把包括 `: keep-alive` 注释在内的任何字节上报给空闲计时器；重试对齐 dsh（5 次，500ms→10s，10% 抖动，Retry-After 优先）；`run-subset.sh` 峰时提示 + `HC_BENCH_WAIT_OFFPEAK=1` 等到谷时。

### P2 · 对齐实验（全部用 eval 度量，赢了才合入）

**P2-1 DSML / 纯文本工具调用兜底解析**（新文件 `provider/dsml-salvage.ts`，与 `prompt-tools.ts` 并列）
- 流式中检测 `<｜DSML｜invoke name="…">…</｜DSML｜invoke>`（V4 紧凑）与 `<｜DSML｜ invoke name="…">`（V4.1 带空格）两种文法，`parameter name=… string="true"` 取字面量、`string="false"` 走 `parseLooseJSON`；像 `PromptToolParser` 一样只扣留可能成为标记前缀的后缀，正文不闪烁。
- 裸格式 `toolname{…json…}` 只在 finish=stop、无 tool_calls、且尾部恰好是"已注册工具名 + 合法 JSON"时才回收。
- 遥测计数 `toolCallSalvaged`，单测用 vLLM #48931 / smg #2525 里的样本。
- 配套缓解：工具数量保持少（ROADMAP C 的 MCP 延迟加载），因为故障与长上下文、工具多相关。

**P2-2 工具形态 A/B**（`tools/edit.ts`、`tools/read.ts`）
- (a) 参数改 snake_case `file_path/old_string/new_string/replace_all`（dsh 与 Claude Code 同款）vs 现在的 camelCase；(b) `read` 输出带行号、offset 1-based；(c) `edit` 分级模糊匹配（ROADMAP C quick win）。
- 指标：6 个任务 + Harbor 子集上的工具错误率、回合数、diff 大小。任一项不赢就不改（改了要重录 cassette）。

**P2-3 strict tools（beta）**：capability `strictTools`，请求时切 `/beta` 根、给每个 function 加 `strict: true`、从 schema 中剔除 min/maxLength、min/maxItems。度量 parseError 率。低优先。

**P2-4 原生 Messages provider**：ROADMAP §2 A 已有；DeepSeek `/anthropic` 端点 + dsh 默认 Messages 让它变成 Claude/DeepSeek 双用。不在本方案执行范围。

### 明确不做
- 不发送 dsh 的 `x-deepseek-harness-*` 头和 `dsh_session_log`（那是 DeepSeek 自家遥测）。
- 不设置 `user_id`（会分区缓存）。
- 不切 Responses API。
- 不引入 DeepSeek tokenizer（现有 `createTokenCalibrator` 用真实 usage 校准已够用）。

---

## 三、关键文件

| 文件 | 改动 |
|---|---|
| `packages/core/src/provider/openai-compat.ts` | reasoning_content 回传、`""` 代替 null、effort 映射、finish_reason/402 映射、空完成重试、空闲超时、DSML 兜底接入 |
| `packages/core/src/provider/capabilities.ts` | `deepseek-flash` 规则、provider 默认、effortLevels、峰谷定价、`reasoningReplay` / `systemPromptUpdate` / `strictTools` 标志、`estimateCostUSD(at)` |
| `packages/core/src/provider/types.ts` | `ModelRequest.reasoningEffort`、`Pricing.offPeak`、system 历史节点 |
| `packages/core/src/provider/sse.ts` | 注释活动回调 |
| `packages/core/src/agent/loop.ts` | 请求构造去 extraBody、system 快照追加、空完成/纯 reasoning 处理、自愈重试 |
| `packages/core/src/agent/session-runner.ts` | 工具一次性注册、子代理/summarizer effort |
| `packages/core/src/subagents/run.ts` | `reasoningEffort` |
| `packages/core/src/context/compactor.ts` | 暖前缀摘要请求、`contextBudgetTokens` |
| `packages/core/src/config/settings.ts` | 默认模型、`contextBudgetTokens` |
| `evals/src/harness.ts`、`evals/tasks/*/task.json`、`evals/baseline.json`、`evals/harbor/run-subset.sh`、`scripts/record-demo.sh`、`README.md`、`.agent/settings.example.json` | 模型 id、effort、峰时提示 |
| 测试：`openai-compat.test.ts`、`router.test.ts`、`compactor.test.ts`、`loop.test.ts`、新 `dsml-salvage.test.ts` | 见各项 |

可复用：`PromptToolParser`（扣留后缀的流式解析骨架）、`parseLooseJSON`、`coerce.ts`、`withEphemeralNotes`、
`createTokenCalibrator`、`cacheHitRate`（CLI 已展示缓存命中率，见 `packages/cli/src/format.ts`）。

---

## 四、验证

**§1 实测探针 —— 已跑（2026-09-19，deepseek-flash，谷时，全部 5 项共几分钱）**

脚本固化在 [`scripts/deepseek-probe.mjs`](../scripts/deepseek-probe.mjs)，读 `DEEPSEEK_API_KEY`（或 `.env`），
`node scripts/deepseek-probe.mjs` 全跑、`node scripts/deepseek-probe.mjs 1 3` 挑着跑、
`HC_PROBE_MODEL=deepseek-v4-pro` 换模型。每项打印实测结果和它对代码意味着什么，全部符合预期则退出码 0。

| # | 问题 | 实测结果 | 结论 |
|---|---|---|---|
| 1 | 带 tools 时不回传 `reasoning_content` 会不会 400 | **不会**。回传 200、省略 200、从纯文本轮里删掉也 200；`deepseek-flash` 和 `deepseek-v4-pro` 一致 | 调研里"不回传必 400"这条**不成立**。仍然回传（dsh 同款做法，且能让前缀和缓存里的字节完全一致），`openai-compat.ts` 的 400 自愈降级为保险 |
| 2 | 历史里有一条从未带 reasoning 的 assistant 轮 | 省略 / `""` / 占位字符串都是 200 | 保持现状：什么都不发。不需要主动注入 `""` |
| 3 | Chat Completions 是否"以最后一条 system 为准" | **是**，连续 3 次都答出后追加的暗号 | **P1-1 的前置条件成立**，in-history system prompt 更新可以做 |
| 4 | thinking 下 `tool_choice` 与 effort 档位 | `none` 可用；`required` 400（`Thinking mode does not support this tool_choice`）；`minimal/low/medium/high/xhigh/max` 全部 200，只有瞎编的 `ultra` 422 | 压缩请求保留 tools + `tool_choice:'none'` 是安全的（P1-2 已这么做）。effort **不是**"多发即拒"：端点照单全收，`effortLevels` 收窄到三档是我们自己的取舍（只展示有区别的档位），不是端点强制 |
| 5 | 同一前缀连发两次的缓存命中 | 第二次 1792/1963 prompt token 命中，约 **91%** | 缓存确实覆盖 system + tools，P1 这一整档的前提成立 |
| 6 | 模式切换那一回合：改写头部 / 追加完整 prompt / 只追加改动段，哪个便宜 | 短历史 $0.000097 / $0.000275 / **$0.000040**；长历史 $0.000515 / $0.000279 / **$0.000045** | **追加完整 prompt 在短历史上比改写头部还贵**（正文被复制一份）。只追加改动段在短历史上省约 2 倍、长历史上省约 11 倍——P1-1 按"只发 delta"实现 |
| 7 | delta 更新模型认不认，尤其是"撤销某一段" | 追加限制 → no/no/no；撤销限制 → yes/yes/yes | 两个方向都成立。消失的段必须**用文字明确作废**（省略无法撤销已经说过的话），这点已写进 `system-update.ts` |

单次采样的 reasoning token 数在各档之间没有单调关系（43–101 token 来回跳），要判断 minimal/xhigh 到底折叠到哪一档，
需要多次重复取中位数——目前没做，也不影响 `mapEffort` 的保守映射。

**§2 单测 / 类型**：`pnpm typecheck && pnpm test`。新增用例：deepseek caps 下出站消息含 reasoning_content、default caps 不含；`content` 为 `""`；effort 映射表；`insufficient_system_resource` → 可重试；402 → quota；峰谷定价选档；DSML 两种文法 + 裸格式回收；压缩请求 = 原 system/tools + 原消息 + 尾部指令。

**§3 回归与能力**
- 重录 cassette（谷时）：`pnpm eval --record --model deepseek/deepseek-flash`，再 `pnpm eval --update-baseline`；之后每次改动 `pnpm eval`。
- 改前改后各跑 `pnpm eval --live --suite capability --runs 5`，对比：pass^k、回合数、工具错误率、`cachedInputTokens / inputTokens`、每任务成本。
- P1-1 / P1-2 / P2-2 用 `pnpm eval --ablation <dim>` 成对比较。

**§4 手工**：`hc -m deepseek/deepseek-flash` 多轮 + 中途切 plan 模式，观察 CLI 输出里的 `cache xx%` 在 P1-1 后不再归零；`--resume` 旧会话不 400。

---

## 来源

- 官方：`api-docs.deepseek.com` 的 [thinking_mode](https://api-docs.deepseek.com/guides/thinking_mode)、[tool_calls](https://api-docs.deepseek.com/guides/tool_calls)、[kv_cache](https://api-docs.deepseek.com/guides/kv_cache)、[rate_limit](https://api-docs.deepseek.com/quick_start/rate_limit)、[pricing](https://api-docs.deepseek.com/quick_start/pricing)、[anthropic_api](https://api-docs.deepseek.com/guides/anthropic_api)、[create-chat-completion](https://api-docs.deepseek.com/api/create-chat-completion)、[news260910](https://api-docs.deepseek.com/news/news260910)、[updates](https://api-docs.deepseek.com/updates/)、[agent_integrations/claude_code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)、[error_codes](https://api-docs.deepseek.com/quick_start/error_codes)
- dsh：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的 `packages/llm/llm-deepseek/README.md` 与 `src/protocols/chat-completions/{serialize,translate,sse}.ts`、`packages/compaction/compaction-basic/README.md`、`packages/compaction/compaction-tool-result-pruner/README.md`、`packages/fs/tool-fs/README.md`、`packages/fs/tool-str-replace-editor/README.md`、`packages/llm/llm-retry/README.md`、`packages/core/agent-loop/README.md`
- 社区：[opencode #24114](https://github.com/anomalyco/opencode/issues/24114) / [#24722](https://github.com/anomalyco/opencode/issues/24722)、[pi #8838](https://github.com/earendil-works/pi/issues/8838)、[openclaw #71455](https://github.com/openclaw/openclaw/issues/71455)、[dotcraft #263](https://github.com/DotHarness/dotcraft/issues/263)、[DeepSeek-V3 #1244](https://github.com/deepseek-ai/DeepSeek-V3/issues/1244)、[vllm #48931](https://github.com/vllm-project/vllm/issues/48931)、[smg #2525](https://github.com/smg-project/smg/pull/2525)、[huggingface.co/blog/deepseekv4](https://huggingface.co/blog/deepseekv4)、[aihubmix 的 V4 Pro 0813 三协议实测](https://aihubmix.com/blog/deepseek-v4-pro-0813-thinking-passback-3-api-matrix)
