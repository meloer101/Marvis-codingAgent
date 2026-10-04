# Harness 自身的改进点（2026-10 Terminal-Bench 运行）

这份清单只收 **hc 自己的机制**能改的问题，不收模型能力问题。证据来自三次 Harbor 运行，共 99 次试跑：

- 9-23/24 全量（`deepseek-flash`，89 个任务各跑 1 次）；
- 10-04 失败重跑（同一模型，9-23/24 的 16 个失败任务，开着 verify-stop）。

数字都是从每次试跑的 `agent/hc.log` 统计出来的。轨迹在 `evals/harbor/.jobs/2026-09-23__11-37-38/`、
`…/2026-09-24__15-53-27/`、`…/2026-10-04__09-03-02/`，已 gitignore，只在本机。运行记录和失败模式表见
[ROADMAP.md §G](ROADMAP.md)。

| # | 问题 | 关键证据 | 改进方向 | 尺寸 |
| --- | --- | --- | --- | --- |
| 1 | 长任务没有像样的管理方式 | 99 条命令被手动放到后台，13 次 `sleep` 干等（最长 900 秒），16 条命令跑了超过 10 分钟 | 默认打开后台命令，并加一个"等到某个条件再返回"的能力 | M |
| 2 | 轮数预算管理太粗 | 10-04 的 11 个失败里有 4 个停在第 40 轮；74% 的轮次只调一个工具；verify-stop 在第 40 轮触发时已经没有轮数可用 | verify-stop 预留轮数；快到上限时保住可用的交付物；放宽轮数实验 | S–M |
| 3 | 上下文管理没在真实任务上跑过 | 99 次试跑里压缩触发 0 次，上下文最高到 169k/192k（88%） | 和放宽轮数的实验一起，做第一次真实的压缩检验 | S（实验） |
| 4 | 没有独立核验，子 agent 在评测里被关掉 | verify-stop 触发 11 次只改对 1 次；4 个任务和上次错得一模一样；adapter 带着 `--no-subagents` | 内置一个全新上下文的审查子 agent | M–L |
| 5 | bash 才是主战场，却最缺测试 | 2947 次工具调用里 bash 占 68%；这一轮修的两个 bug 都在 bash 里 | 确定 shell 优先的策略，给 bash 补健壮性测试 | S–M |
| 6 | 设置只能写文件 | `verifyBeforeStop` 没有命令行开关，只能往容器里写 `~/.agent/settings.json` | 加一个通用的 `--setting key=value` | S |

---

## 1. 长任务没有像样的管理方式

**现象**

- 99 条 bash 命令是模型自己用 `nohup … &` 或 `&` 放到后台的，然后靠 `sleep N; tail log` 轮询。其中 13 次
  等待在 10 秒以上，最长一次是 `compile-compcert` 里的 `sleep 900`。
- 16 条命令实际跑了超过 10 分钟，28 条超过 5 分钟。最长的约 24 分钟，例如 `fix-ocaml-gc` 里的
  `make -j4` 跑了 21 分钟。
- hc 其实有后台命令（`run_in_background`、`bash_output`、`bash_kill`），但它挂在
  `backgroundProcesses` 设置后面，默认关闭（[settings.ts](../packages/core/src/config/settings.ts)），Harbor 上也没打开。

**为什么算 harness 的问题**

模型只能拿 shell 拼一套后台和轮询的办法，既浪费墙钟时间（`sleep` 的时候什么都没在推进），又浪费轮数（每轮询一次就是一轮）。

**改进方向**

1. 默认打开 `backgroundProcesses`。代价是模型看到的工具集变了，回归测试的回放要重录。
2. 给 `bash_output` 加上等待能力：阻塞到进程退出，或者输出里匹配到某个正则，再设一个超时上限，取代 `sleep` 轮询。
3. Harbor adapter 支持打开这个设置（另见 #6）。

**怎么验证**

在长构建类任务上跑 Harbor（`compile-compcert`、`fix-ocaml-gc`、`build-pov-ray`、`caffe-cifar-10`），比较 `sleep`
轮询的次数、墙钟时间和轮数。

---

## 2. 轮数预算管理太粗

**现象**

- 10-04 的 11 个失败里，有 4 个停在第 40 轮：`make-doom-for-mips`、`make-mips-interpreter`、`sam-cell-seg`、
  `train-fasttext`。几个大任务停下的时候，交付物还是坏的。
- 74% 的轮次只调用一个工具（20% 调两个），平均每轮 1.19 次，互不相关的读取和检查几乎都是一轮一个。
- verify-stop 只在模型自己决定结束的时候触发，而且它占用的也是这 40 轮。`train-fasttext` 到第 40 轮、
  `sam-cell-seg` 到第 39 轮才触发，已经没有轮数可以拿来验证或修改了。
- 轮数提醒已经有了（[loop.ts](../packages/core/src/agent/loop.ts) 的 `turnBudgetNote`，在 60%、80% 和最后一轮
  提醒），最后一轮还会明确要求"把当前最好的方案落到目标文件上"，但交付物仍然停在坏的状态。

**改进方向**

1. **verify-stop 预留轮数**：剩下的轮数不够就不触发；或者让验证阶段不计入预算；或者在 80–85% 处就提前做一次核验。
2. **保住可用的交付物**：这一条机制还没想清楚。候选方案是在 80% 处检查交付物是否存在、能否运行，不能就要求先恢复到能运行的状态。这和失败模式 #4"交付物投入过晚"是同一件事。
3. **批量调用**：鼓励把互不相关的读取和检查放在同一轮发出。这一条属于提示词层面，效果要测。
4. **轮数上限本身**：40 是 adapter 的默认值，Terminal-Bench 只限墙钟时间。先用 `--ak max_turns=100` 重跑这几个
   大任务，看到底是上限卡住了，还是它们本来就做不出来。

**怎么验证**

在 3 个大任务上做放宽轮数的实验（同时承担 #3 的检验）；看 verify-stop 改了触发时机以后，`train-fasttext` 这类任务还会不会白触发。

---

## 3. 上下文管理没在真实任务上跑过

**现象**

- 99 次试跑里压缩一次都没触发，只出现过 3 次上下文告警。
- 上下文峰值最高的几次是 `gpt2-codegolf` 169k、`make-doom-for-mips` 165k、`regex-chess` 162k，窗口是 192k，压缩阈值是 92%
  （[compactor.ts](../packages/core/src/context/compactor.ts)）。一半试跑的上下文峰值不到 35k。
- 本地评测也测不到这一层，ROADMAP 里写着 compaction 消融"在现在的小 fixture 上测不出"。

**为什么重要**

压缩器，包括它"压缩时不能丢掉安全约束"那套规则，是 hc 的核心机制之一，但从来没在真实长任务上运行过。轮数上限一放宽，最长的那几个任务就会开始压缩：摘要质量怎么样、题目里的明确要求会不会在压缩时丢掉（这正是失败模式 #12 的病根）、前缀缓存会不会被打断，现在全都不知道。

**改进方向**

1. 和 #2 的放宽轮数实验合成一次跑，把发生了压缩的试跑逐条读：压缩后的第一轮模型还记不记得题目的明确要求和自己做到了哪一步。
2. 检查 DeepSeek 的 `reasoning_content` 在压缩前后的处理，是否符合 DeepSeek 自己的规则。上下文这一层是按模型适配的，不是所有模型都一样。
3. 如果压缩的触发次数还是太少，就做一个大仓库探索的 fixture（ROADMAP 里已经列着这一项）。

---

## 4. 没有独立核验，子 agent 在评测里被关掉

**现象**

- 10-04 verify-stop 一共触发 11 次，只有 `adaptive-rejection-sampler` 一次真的查出了问题并改掉。另外几个通过的任务，
  在验证提示出现之前就已经做对了。失败的 5 个，验证阶段都回答"所有要求都满足"。
- 失败是系统性的，重跑一次错法一模一样：
  - `gcode-to-text` 又回答"看不清的涂抹"，正确答案是一串 flag；
  - `raman-fitting` 又把 x 轴当成 cm⁻¹，G 峰位置拟合到 19258，正确值是 1580；
  - `filter-js-from-html` 又改坏了 12 个干净文件里的 5 个；
  - `model-extraction-relu-logits` 又差第 24 行。
- verify-stop 的提示让模型逐条列出"明确要求"：路径、格式、语法、命名、阈值
  （[verify-stop.ts](../packages/core/src/agent/verify-stop.ts)）。模型照做了，查的全是格式；而剩下的错误都符合格式，错在内容本身。根本原因是模型拿同一个错误前提检查自己的结果。
- hc 有子 agent（`task` 工具，内置 `explore` 和 `plan`），但没有审查用的子 agent。Harbor adapter 还带着
  `--no-subagents --no-mcp --no-skills`（[hc_agent.py](../evals/harbor/hc_agent.py)），所以 Terminal-Bench 测的是一个精简版 hc，
  不是用户实际拿到的产品。

**改进方向**

1. 内置一个审查子 agent：只给它题目原文和交付物的位置，不给之前的推理过程，任务是找出交付物为什么是错的，并且用独立的办法核对：换一种方法再算一遍，或者检查数据里的反常信号（比如数值范围、单位）。
2. 用它来实现 verify-stop，取代现在"同一个上下文里再提醒一遍"的做法。
3. Harbor 上加一组打开子 agent 的对照，测的就是产品的真实配置。

**怎么验证**

因为这些失败每次都错在同一个地方，在上面 4 个失败任务加上 `dna-assembly`、`train-fasttext` 上各跑一两次就能看出效果。

---

## 5. bash 才是主战场，却最缺测试

**现象**

- 2947 次工具调用里，`bash` 占 2012 次（68%），`write` 471 次，`edit` 211 次，`read` 只有 165 次，`grep` 18 次，`glob` 10 次。
- `bash` 的出错率是 19%（383/2012），其中包括正常的非零退出，比如测试没通过。
- 这一轮修的两个 bug 都在 bash 里：超时只 kill 了 `sh`（`5ae0284`），`timeoutMs` 没有上限（`dc823a0`）。前一个从最早的版本起就存在，因为从来没有测试跑过会卡住的命令。
- 专用工具的特性大多被绕过去了：`read` 的行号、`grep` 跳过密钥文件。bash 里的 `guardSecretSearch` 只覆盖了一部分。

**改进方向**

1. **明确策略**：要么接受 shell 优先，把投入集中到 bash（输出截断、长任务 #1、超时、错误信息）；要么让专用工具更好用，比如改进描述、让工具名和参数贴近主流 harness。在别的 harness 里训练出来的模型，默认就习惯用 shell。
2. **补一套 bash 健壮性测试**：会卡住的命令、超大输出、二进制输出、留在后台的子进程、信号和中断、不存在的解释器（Harbor 里出现过 `python3: not found`、`time: not found`）。

---

## 6. 设置只能写文件

**现象**

- `verifyBeforeStop` 这类设置没有命令行开关。10-04 要在 Harbor 上打开它，只能让 adapter 往容器里写
  `~/.agent/settings.json`（`--ak verify_stop=true`），Harbor 的 `--ae` 也传不了设置。
- `pnpm eval --ablation` 只覆盖固定的几个维度，新开关每次都得改代码。

**改进方向**

1. 加一个可重复的 `--setting key=value`，或者 `HC_SETTINGS` 环境变量（JSON），作为优先级最高的一层合并进来。它要守和项目层一样的限制：不能通过它给自己授权 auto mode（[settings.ts](../packages/core/src/config/settings.ts) 里 `loadSettings` 的规则）。
2. Harbor adapter 把 `--ak setting.<key>=<value>` 原样传给 hc，以后加开关就不用再改 adapter。

---

## 相关但不在这 6 条里

- **hc 的文件 agent 能看到（未解决）**：`extract-elf` 去翻 `/opt/hc/hc.mjs`、`/logs/agent/hc.log`、`/root/.agent/`，找"reference solution"。
  这会让跑分不可信，也可能是产品行为上的隐患。见 ROADMAP 的摩擦表。
- **bash 超时不生效（已修，`5ae0284`）**、**`timeoutMs` 没有上限（已修，`dc823a0`）**。
- **CI 上的回放测试**在 Linux 上必然失败：录音里有 `ls -la` 的属主、属组和目录大小，清洗规则没有处理这几列
  （[harness.ts](../evals/src/harness.ts) 的 `evalKeyScrub`）。
