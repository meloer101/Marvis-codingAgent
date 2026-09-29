# coding-e2e 评测用例（19 个）

被测：`hc agent`（真实命令入口）+ `deepseek/deepseek-flash`，acceptEdits 模式，每个用例 3 次。每次在全新临时目录里跑（拷贝 fixture → git init 提交一次 → 独立的临时 HOME 和状态目录）。

分组：regression 6 个（旧任务，已满分，防退化）· failure-mode 7 个（改写自 ROADMAP 失败模式表）· typical 6 个（覆盖面广的典型编码任务）。

每个新任务都验证过：空白 fixture 不过、参考解能过、2–9 个"看起来对但错"的近似解全部不过（共 79 个）。隐藏检查在 `evals/tasks/<id>/assert.mjs`，不会拷进工作区。

| # | id | tags | 语言 | 隐藏检查（摘要） |
|---|---|---|---|---|
| 1 | [fix-null-deref](#fix-null-deref) | regression, bug-fix | English | `node --test` 全过；test 文件没改。 |
| 2 | [add-slug-helper](#add-slug-helper) | regression, feature | English | 不再是 stub；测试全过。 |
| 3 | [extract-duplication](#extract-duplication) | regression, refactor | English | 空白规范化只剩一处；多出一个 helper 函数；测试全过。 |
| 4 | [cover-parse-edge-cases](#cover-parse-edge-cases) | regression, write-tests | English | src 没改；原测试还在；至少 3 个错误路径断言；测试全过。 |
| 5 | [verify-stated-requirements](#verify-stated-requirements) | regression, verify, fm-12 | English | 输出逐字节正确（恰好一个结尾换行）；路径从参数读（换一份输入再跑）；只用内置模块。 |
| 6 | [verify-clean-input-unchanged](#verify-clean-input-unchanged) | regression, verify, fm-12 | English | 6 个没有 script 的文件逐字节不变（CRLF、无结尾换行、中文、noscript…）；3 个有 script 的删干净且不动其它内容。 |
| 7 | [edit-env-example-ok](#edit-env-example-ok) | failure-mode, over-refusal, fm-2 | English | .env.example 加上 LOG_LEVEL；原条目保留；.env 未改；密钥没泄露到任何文件。 |
| 8 | [buried-report-requirements](#buried-report-requirements) | failure-mode, verify, fm-12 | English | sample 报告完全正确；再用 TZ=Pacific/Honolulu 在一份隐藏日志上跑（跨 2 月底、+09/-03 时区、边界秒、空天）。 |
| 9 | [match-caller-interface](#match-caller-interface) | failure-mode, verify, fm-12 | English | 假时钟下：连续补充、上限、失败不扣、毫秒向上取整、cost>capacity → Infinity、各 key 独立；再真跑 server.js（429 + Retry-After）和 sync.js 的日志。 |
| 10 | [order-dependent-test](#order-dependent-test) | failure-mode, bug-fix, fm-7 | English | 可见测试全过；test 文件哈希不变；隐藏检查两个函数都不再把参数泄露到后续调用。 |
| 11 | [reconcile-totals-diagnosis](#reconcile-totals-diagnosis) | failure-mode, diagnosis, fm-13, zh | 中文 | answer.txt 恰好是 7 个受影响 id；用原始数据跑合计要和财务一致；再用一份隐藏生成的数据跑（防硬编码、防改数据）。 |
| 12 | [recover-before-probe](#recover-before-probe) | failure-mode, recovery, fm-11 | English | out/orders.json 恰好是 47 条（按 id 排序、字段完整）；47 条在 out/ 以外仍有存档（没丢数据）。 |
| 13 | [simple-perf-fix](#simple-perf-fix) | failure-mode, perf, fm-3 | English | 输出与原算法逐项一致（含奇怪邮箱、+tag、大小写）；22 万行 2 秒内；没加依赖。 |
| 14 | [http-endpoint-feature](#http-endpoint-feature) | typical, feature, zh | 中文 | 分页全程走一遍（含"最后一页刚好满"时 nextCursor=null）；各种非法参数 400 + invalid_param；旧接口不坏；新增了真正请求 GET /todos 的测试。 |
| 15 | [python-csv-import-bug](#python-csv-import-bug) | typical, bug-fix, python | English | 两份 sample 和一份隐藏文件解析结果完全正确（BOM、CRLF、引号内逗号、转义双引号、空行）；CLI 退出 0；unittest 通过。 |
| 16 | [cli-flags-feature](#cli-flags-feature) | typical, feature, zh | 中文 | TZ=Asia/Shanghai 下：纯日期按 UTC 0 点、含边界、m/h/d 相对时间、非法值退出码 2 且 stdout 为空、--json 原样输出、与现有参数组合、README 更新。 |
| 17 | [callbacks-to-async](#callbacks-to-async) | typical, refactor | English | plugins/ 与测试逐字节不变；回调恰好调用一次、错误路径不产生 unhandledRejection；Promise API 正确；app.js 用 await；CLI 输出与改前一致。 |
| 18 | [concurrency-limit-bug](#concurrency-limit-bug) | typical, bug-fix, zh | 中文 | 手控 deferred 下：两种模式并发都不超过 limit（含大量失败后）、结果按输入顺序、默认模式首错后不再启动新任务、同步 throw 算 reject；crawl.js 未改。 |
| 19 | [merge-conflict-resolution](#merge-conflict-resolution) | typical, merge | English | 无冲突标记；三个测试文件不变且通过；12 组 total() 组合（固定额券 + 税、起用门槛按税前）；README 两个选项都在。 |

---

## 1. fix-null-deref

tags: `regression`, `bug-fix` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
The test suite (run it with `npm test`) is failing. Find the bug in src/config.js and fix it so every test passes. Do not change any file under test/.
~~~

**初始文件：** `package.json` `src/config.js` `test/config.test.mjs`

**隐藏检查：** `node --test` 全过；test 文件没改。

**难点 / 来源：** 旧任务，flash 一直 3/3。

## 2. add-slug-helper

tags: `regression`, `feature` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
Implement the slugify function in src/slug.js so the whole test suite passes (run it with `npm test`). Do not change the tests.
~~~

**初始文件：** `package.json` `src/slug.js` `test/slug.test.mjs`

**隐藏检查：** 不再是 stub；测试全过。

**难点 / 来源：** 旧任务，flash 一直 3/3。

## 3. extract-duplication

tags: `regression`, `refactor` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
Both functions in src/format.js repeat the same name-normalization-and-initials logic. Extract that shared logic into one helper function and call it from both. `npm test` must still pass and the files under test/ must not change.
~~~

**初始文件：** `package.json` `src/format.js` `test/format.test.mjs`

**隐藏检查：** 空白规范化只剩一处；多出一个 helper 函数；测试全过。

**难点 / 来源：** 旧任务，flash 一直 3/3。

## 4. cover-parse-edge-cases

tags: `regression`, `write-tests` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
src/parseRange.js is correct but under-tested. Add tests to test/parseRange.test.mjs covering the three error paths: malformed input, an inverted range (high < low), and the too-wide guard. Keep the existing test. `npm test` must pass.
~~~

**初始文件：** `package.json` `src/parseRange.js` `test/parseRange.test.mjs`

**隐藏检查：** src 没改；原测试还在；至少 3 个错误路径断言；测试全过。

**难点 / 来源：** 旧任务，flash 一直 3/3。

## 5. verify-stated-requirements

tags: `regression`, `verify`, `fm-12` · mode: `acceptEdits` · maxTurns: 20 · 放行命令: `Bash(node:*)` `Bash(mkdir:*)`

**提示语（原样）：**

~~~text
Write `transform.js` that turns a CSV like data/input.csv into the format of data/expected.csv: the name upper-cased, then qty × price with two decimals, `;`-separated, sorted by that total, highest first. `node check.js` compares out/output.csv against the expected file.

Requirements:
- It is run as `node transform.js <input.csv> <output.csv>`; don't hard-code either path.
- The output ends with exactly one newline.
- Use only Node's built-in modules.

Leave out/output.csv in place, produced from data/input.csv.
~~~

**初始文件：** `check.js` `data/expected.csv` `data/input.csv` `out/.gitkeep`

**隐藏检查：** 输出逐字节正确（恰好一个结尾换行）；路径从参数读（换一份输入再跑）；只用内置模块。

**难点 / 来源：** 旧 capability 任务，flash 开关 verify-stop 都是 5/5。

## 6. verify-clean-input-unchanged

tags: `regression`, `verify`, `fm-12` · mode: `acceptEdits` · maxTurns: 20 · 放行命令: `Bash(node:*)` `Bash(cp:*)` `Bash(diff:*)` `Bash(cmp:*)`

**提示语（原样）：**

~~~text
Write `sanitize.js`: `node sanitize.js <file.html>` removes every `<script>…</script>` element from that HTML file, in place. A file with no script element must be left byte-for-byte unchanged. There are a couple of examples in samples/.
~~~

**初始文件：** `samples/clean.html` `samples/dirty.html`

**隐藏检查：** 6 个没有 script 的文件逐字节不变（CRLF、无结尾换行、中文、noscript…）；3 个有 script 的删干净且不动其它内容。

**难点 / 来源：** 旧 capability 任务，flash 两组都是 5/5。

## 7. edit-env-example-ok

tags: `failure-mode`, `over-refusal`, `fm-2` · mode: `acceptEdits` · maxTurns: 12 · 放行命令: （无）

**提示语（原样）：**

~~~text
src/config.js now reads a LOG_LEVEL setting (default `info`). Document it in .env.example next to the existing entries so new contributors know it exists. Keep .env.example free of real values.
~~~

**初始文件：** `.env` `.env.example` `src/config.js`

**隐藏检查：** .env.example 加上 LOG_LEVEL；原条目保留；.env 未改；密钥没泄露到任何文件。

**难点 / 来源：** 失败模式 #2（过度拒绝）。近期 0/5：每次约 6 次工具调用被权限引擎当成密钥文件拒掉——是 harness 策略问题，正是改 harness 能修的。

## 8. buried-report-requirements

tags: `failure-mode`, `verify`, `fm-12` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(node:*)` `Bash(npm:*)` `Bash(mkdir:*)`

**提示语（原样）：**

~~~~text
Write `summarize.js`, which turns our service log into a per-day report. It is run as `node summarize.js <log file> <from> <to> <out.json>`, with dates written like 2026-09-01. The report needs one entry for every day from `from` through `to`, both ends included, and a day with no log entries still gets an entry, with zeros; the days are UTC days, so apply each timestamp's offset before deciding which day a line belongs to, and ignore lines that fall outside the range. A line that can't be parsed (anything other than a timestamp with its offset, a space, one of INFO, WARN or ERROR, and the message) is left out of the day counts, but every such line in the file is tallied in a top-level `skipped`; blank lines count as nothing. For each day, `errorRate` is that day's ERROR lines as a percentage of its total, rounded to one decimal place, and 0 when the day has no entries, and the keys of `days` are in chronological order. The file should look like this (counts invented):

```json
{
  "skipped": 2,
  "days": {
    "2026-09-01": { "total": 12, "info": 7, "warn": 3, "error": 2, "errorRate": 16.7 },
    "2026-09-02": { "total": 0, "info": 0, "warn": 0, "error": 0, "errorRate": 0 }
  }
}
```

`node check.js` sanity-checks out/report.json. When you're done, leave out/report.json in place, generated from logs/app-2026-09.txt for 2026-09-01 through 2026-09-07.
~~~~

**初始文件：** `README.md` `check.js` `logs/app-2026-09.txt` `out/.gitkeep` `package.json`

**隐藏检查：** sample 报告完全正确；再用 TZ=Pacific/Honolulu 在一份隐藏日志上跑（跨 2 月底、+09/-03 时区、边界秒、空天）。

**难点 / 来源：** 失败模式 #12。要求全埋在一段话里：含两端、空天补零、按 UTC 分天、`skipped` 计数、空天 errorRate=0、按日期排序。可见的 check.js 只查总数。

## 9. match-caller-interface

tags: `failure-mode`, `verify`, `fm-12` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
src/ratelimit.js is still a stub, and src/server.js and src/jobs/sync.js already use it. Implement it: a token bucket per key, where each key starts full at `capacity` tokens and refills continuously at `refillPerSec` tokens per second, never going above `capacity`. A call costs one token unless the caller asks for more. A call that can't be paid for in full takes nothing and says how long to wait until it could be, in whole milliseconds rounded up; a cost larger than the capacity can never be paid, so its wait is `Infinity`. Every call also reports how many tokens the key has left afterwards, unrounded. Besides the options its callers pass, `createLimiter` accepts an optional `now` (a function returning the current time in milliseconds, `Date.now` by default) so tests can control the clock. `npm test` runs the existing tests.
~~~

**初始文件：** `package.json` `src/jobs/sync.js` `src/main.js` `src/ratelimit.js` `src/server.js` `test/server.test.mjs`

**隐藏检查：** 假时钟下：连续补充、上限、失败不扣、毫秒向上取整、cost>capacity → Infinity、各 key 独立；再真跑 server.js（429 + Retry-After）和 sync.js 的日志。

**难点 / 来源：** 失败模式 #12（接口和调用方不符）。接口只能从调用方看出来，stub 上的旧注释指向错误的 `limit(key)` 设计。

## 10. order-dependent-test

tags: `failure-mode`, `bug-fix`, `fm-7` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
`npm test` fails on the 'formats totals with the default locale' test, but that test passes when I run it on its own (`node --test --test-name-pattern='default locale'`). Please find the actual bug and fix it in src/report.js, everywhere that mistake appears, not only where this test trips over it. Don't edit the tests.
~~~

**初始文件：** `package.json` `src/report.js` `test/report.test.mjs`

**隐藏检查：** 可见测试全过；test 文件哈希不变；隐藏检查两个函数都不再把参数泄露到后续调用。

**难点 / 来源：** 失败模式 #7（钻牛角尖）。症状像 locale/ICU 问题（`1.234,50`），实际是共享默认对象被改写；同类 bug 还有第二处，可见测试碰不到。提示语里写了"这个错误出现的所有地方都要修"。

## 11. reconcile-totals-diagnosis

tags: `failure-mode`, `diagnosis`, `fm-13`, `zh` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)` `Bash(awk:*)`

**提示语（原样）：**

~~~text
每晚的对账任务（`npm run totals`，代码在 src/totals.js）算出来的各账户合计，和财务导出的 finance/export.csv 对不上，有几个账户差了一点。帮我查清楚原因，修好 src/totals.js，让结果和财务一致。data/transactions.csv 是上游每晚原样推过来的，以后也还会是这个样子，所以别改数据，要改代码。

另外把受影响的交易 id 写到 answer.txt，一行一个，顺序不限。“受影响”指现在的代码把这笔交易重复计入了，或者漏算了；同一笔交易只写一次，id 写成去掉首尾空格、转成大写后的形式。
~~~

**初始文件：** `README.md` `data/transactions.csv` `finance/export.csv` `package.json` `src/totals.js` `test/totals.test.mjs`

**隐藏检查：** answer.txt 恰好是 7 个受影响 id；用原始数据跑合计要和财务一致；再用一份隐藏生成的数据跑（防硬编码、防改数据）。

**难点 / 来源：** 失败模式 #13（笃定给出不完整结论）。两个独立原因：大小写/空格不同的重复 id、括号记账格式的退款被当 NaN 跳过。只修一个仍有账户对不上。

## 12. recover-before-probe

tags: `failure-mode`, `recovery`, `fm-11` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(node:*)` `Bash(npm:*)` `Bash(cp:*)` `Bash(mkdir:*)`

**提示语（原样）：**

~~~text
The orders store in data/ lost its last batch in last night's crash: upstream confirms 47 orders were written, but data/orders.db only has 40 of them. The missing ones should still be in the journal next to it. Get all 47 orders out into out/orders.json — a JSON array of the order objects, sorted by id. data/ is the only copy of these orders, so make sure nothing in it gets lost along the way.
~~~

**初始文件：** `README.md` `data/orders.db` `data/orders.db-journal` `package.json` `src/store.js` `test/store.test.mjs` `tools/dbtool.js`

**隐藏检查：** out/orders.json 恰好是 47 条（按 id 排序、字段完整）；47 条在 out/ 以外仍有存档（没丢数据）。

**难点 / 来源：** 失败模式 #11（探查时破坏不可再生的输入）。项目自带的 dbtool 一打开库就会删掉它不认识的新版日志文件——先跑它看看就永久丢 7 条。

## 13. simple-perf-fix

tags: `failure-mode`, `perf`, `fm-3` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
`npm run bench` has gotten painfully slow now that we have more users. Make `findDuplicateEmails` fast enough that the bench finishes in under a second, and would still be well under a second with 10x as many users (`npm run bench -- 200000`). Its behaviour must not change (`npm test` covers the basics), and please don't add any dependencies.
~~~

**初始文件：** `README.md` `package.json` `scripts/bench.js` `src/dedupe.js` `test/dedupe.test.mjs`

**隐藏检查：** 输出与原算法逐项一致（含奇怪邮箱、+tag、大小写）；22 万行 2 秒内；没加依赖。

**难点 / 来源：** 失败模式 #3（过度工程）。一个 Map 就够；可能偏简单，过度工程更多体现在 diff-size 附加指标上。

## 14. http-endpoint-feature

tags: `typical`, `feature`, `zh` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)` `Bash(curl:*)` `Bash(PORT=*)` `Bash(sleep:*)`

**提示语（原样）：**

~~~text
给 todos 加一个列表接口 `GET /todos`：

- 支持 `status=open|done` 过滤，不传就是全部；
- 分页：`limit` 默认 20、最大 100；`cursor` 是上一页最后一条的 id，返回它之后的记录；
- 结果按 id 升序；
- 响应顶层带 `nextCursor`（请求下一页时作为 cursor 传入），没有下一页时为 `null`；
- 参数不合法时返回 400，错误码用现有的 `invalid_param`：status 取值不对、limit 不是 1–100 之间的整数、cursor 对应的 todo 不存在。

响应和错误格式跟现有接口保持一致。顺手把 `GET /todos` 的测试补上，`npm test` 要能过。
~~~

**初始文件：** `README.md` `package.json` `src/db.js` `src/http.js` `src/index.js` `src/router.js` `src/routes/todos.js` `src/routes/users.js` `src/seed.js` `src/server.js` `test/todos.test.mjs` `test/users.test.mjs`

**隐藏检查：** 分页全程走一遍（含"最后一页刚好满"时 nextCursor=null）；各种非法参数 400 + invalid_param；旧接口不坏；新增了真正请求 GET /todos 的测试。

**难点 / 来源：** 典型功能。坑：满页时 nextCursor、`parseInt("1.5")`、超限该 400 不是截断、路由前缀匹配顺序。

## 15. python-csv-import-bug

tags: `typical`, `bug-fix`, `python` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(python3:*)` `Bash(python:*)` `Bash(PYTHONPATH=*)`

**提示语（原样）：**

~~~~text
Importing the supplier's new export crashes:

```
$ python3 -m inventory.cli import samples/supplier_2026-09.csv
Traceback (most recent call last):
  ...
KeyError: 'sku'
```

The older exports (like samples/supplier_2026-06.csv) still import fine. Fix the importer so both work. Tests run with `python3 -m unittest`.
~~~~

**初始文件：** `README.md` `inventory/__init__.py` `inventory/cli.py` `inventory/importer.py` `inventory/models.py` `samples/supplier_2026-06.csv` `samples/supplier_2026-09.csv` `tests/__init__.py` `tests/test_cli.py` `tests/test_importer.py`

**隐藏检查：** 两份 sample 和一份隐藏文件解析结果完全正确（BOM、CRLF、引号内逗号、转义双引号、空行）；CLI 退出 0；unittest 通过。

**难点 / 来源：** 典型 bug 修复（Python）。只去 BOM 或手写引号切分都会漏。

## 16. cli-flags-feature

tags: `typical`, `feature`, `zh` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)` `Bash(./bin/logq.js:*)` `Bash(LOGQ_NOW=*)` `Bash(TZ=*)`

**提示语（原样）：**

~~~text
给 logq 加两个参数：

1. `--since <时间>`：只显示这个时间及之后的记录。支持绝对时间（`2026-09-01` 或 `2026-09-01T10:00:00Z`，只写日期时按 UTC 当天 0 点算）和相对时间（`30m`、`2h`、`7d`，从当前时间往前推；测试时可以用环境变量 `LOGQ_NOW`（ISO 格式）指定“当前时间”）。格式不对时往 stderr 打印错误、以退出码 2 退出。
2. `--json`：不输出表格，改成每条记录输出一行 JSON，内容就是原始记录（字段原样保留）。

两个参数可以和现有参数任意组合。README 里的用法说明也更新一下。
~~~

**初始文件：** `README.md` `bin/logq.js` `examples/events.jsonl` `package.json` `src/args.js` `src/filter.js` `src/format.js` `test/cli.test.mjs`

**隐藏检查：** TZ=Asia/Shanghai 下：纯日期按 UTC 0 点、含边界、m/h/d 相对时间、非法值退出码 2 且 stdout 为空、--json 原样输出、与现有参数组合、README 更新。

**难点 / 来源：** 典型功能。坑：纯日期被当本地时间、边界用 `>`、非法值退出码 1、LOGQ_NOW 未设时 NaN。

## 17. callbacks-to-async

tags: `typical`, `refactor` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)` `Bash(KV_DIR=*)` `Bash(rm:*)` `Bash(mkdir:*)`

**提示语（原样）：**

~~~text
Modernize src/store.js: the store's get/set/del/list should return promises (errors reject) so our own code can use async/await, and rewrite src/app.js to use await instead of nested callbacks. The plugins under plugins/ are maintained by another team and can't change, so the callback style they use has to keep working exactly as before. `npm test` must pass.
~~~

**初始文件：** `README.md` `package.json` `plugins/audit.js` `plugins/backup.js` `src/app.js` `src/store.js` `test/store.test.mjs`

**隐藏检查：** plugins/ 与测试逐字节不变；回调恰好调用一次、错误路径不产生 unhandledRejection；Promise API 正确；app.js 用 await；CLI 输出与改前一致。

**难点 / 来源：** 典型重构。坑：回调模式下同时返回一个会 reject 的 promise，在 Node 22 里会直接让进程崩溃；`list(cb)` 无前缀调用。

## 18. concurrency-limit-bug

tags: `typical`, `bug-fix`, `zh` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
我们的爬虫用 src/pool.js 里的 mapLimit 控制并发（limit 是 4），但监控里偶尔能看到同时有 6、7 个请求在跑；另外返回的结果有时候和输入的 url 对不上号。帮忙修一下 pool.js，调用方别动。
~~~

**初始文件：** `README.md` `package.json` `src/cli.js` `src/crawl.js` `src/pool.js` `test/pool.test.mjs`

**隐藏检查：** 手控 deferred 下：两种模式并发都不超过 limit（含大量失败后）、结果按输入顺序、默认模式首错后不再启动新任务、同步 throw 算 reject；crawl.js 未改。

**难点 / 来源：** 典型并发 bug。两个独立 bug（完成顺序收集结果、settle 模式失败时计数器减两次），提示只给症状。

## 19. merge-conflict-resolution

tags: `typical`, `merge` · mode: `acceptEdits` · maxTurns: 30 · 放行命令: `Bash(npm:*)` `Bash(node:*)`

**提示语（原样）：**

~~~text
I merged the `discounts` branch into my `tax` branch and got conflicts — the markers are still in the files. Resolve them so both features work together (coupons and tax). `npm test` must pass.
~~~

**初始文件：** `README.md` `docs/discounts.md` `package.json` `src/cart.js` `src/coupons.js` `test/cart.test.mjs` `test/discounts.test.mjs` `test/tax.test.mjs`

**隐藏检查：** 无冲突标记；三个测试文件不变且通过；12 组 total() 组合（固定额券 + 税、起用门槛按税前）；README 两个选项都在。

**难点 / 来源：** 典型合并冲突。规则在 docs/discounts.md（券在税前用、税按折后算）；最自然的"两边都留"写法会对未折扣金额收税。工作区里没有真实 git 合并状态，只有冲突标记。
