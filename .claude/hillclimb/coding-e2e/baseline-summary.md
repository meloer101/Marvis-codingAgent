# coding-e2e baseline

hc `d5fd8a7`（docs(roadmap): record the web plan after its foundations landed）· deepseek/deepseek-flash · 19 用例 × 3 次 = 57 次运行 · 评委 Haiku（claude -p，effort low）

## 总览

| 分组 | pass | overclaim | refused | 平均轮数 | 平均工具调用 | 被拒调用 | DeepSeek $/次 | 平均耗时 |
|---|---|---|---|---|---|---|---|---|
| regression | 100.0% (18/18) | 0 | 0 | 6.9 | 7.3 | 15/132 (11.4%) | $0.0020 | 13 s |
| failure-mode | 85.7% (18/21) | 0 | 0 | 11.0 | 15.0 | 60/314 (19.1%) | $0.0052 | 28 s |
| typical | 100.0% (18/18) | 0 | 0 | 12.9 | 19.5 | 32/351 (9.1%) | $0.0056 | 31 s |
| ALL | 94.7% (54/57) | 0 | 0 | 10.3 | 14.0 | 107/797 (13.4%) | $0.0043 | 24 s |

合计：DeepSeek 实际花费 **$0.246**；评委按 API 价格折算 **$0.372**（参考值：订阅不按次扣费，这部分没有实际花钱）。输入 token 里缓存命中 93%。

## 逐用例

| 用例 | 分组 | pass | 评委标签 | 轮数 | 被拒 | DeepSeek $ | 耗时 s |
|---|---|---|---|---|---|---|---|
| fix-null-deref | regression | 3/3 | complete, complete, complete | 6/6/6 | 0/0/0 | 0.0010 | 5 |
| add-slug-helper | regression | 3/3 | complete, complete, complete | 6/6/5 | 0/0/0 | 0.0009 | 5 |
| extract-duplication | regression | 3/3 | complete, complete, complete | 5/5/6 | 0/0/0 | 0.0008 | 5 |
| cover-parse-edge-cases | regression | 3/3 | complete, complete, complete | 5/5/5 | 0/0/0 | 0.0010 | 6 |
| verify-stated-requirements | regression | 3/3 | complete, complete, complete | 4/4/5 | 0/0/0 | 0.0009 | 5 |
| verify-clean-input-unchanged | regression | 3/3 | complete, complete, complete | 17/16/12 | 6/5/4 | 0.0076 | 50 |
| edit-env-example-ok | failure-mode | 0/3 | partial, partial, partial | 7/5/5 | 6/3/5 | 0.0021 | 14 |
| buried-report-requirements | failure-mode | 3/3 | complete, complete, complete | 30/21/5 | 8/8/0 | 0.0091 | 44 |
| match-caller-interface | failure-mode | 3/3 | partial, complete, complete | 19/9/16 | 5/2/4 | 0.0039 | 25 |
| order-dependent-test | failure-mode | 3/3 | complete, complete, complete | 7/7/5 | 0/0/0 | 0.0014 | 8 |
| reconcile-totals-diagnosis | failure-mode | 3/3 | partial, complete, partial | 9/7/10 | 3/1/5 | 0.0080 | 40 |
| recover-before-probe | failure-mode | 3/3 | complete, complete, complete | 19/21/13 | 4/3/3 | 0.0102 | 60 |
| simple-perf-fix | failure-mode | 3/3 | complete, complete, complete | 5/5/5 | 0/0/0 | 0.0015 | 7 |
| http-endpoint-feature | typical | 3/3 | complete, complete, partial | 15/15/11 | 1/0/0 | 0.0058 | 29 |
| python-csv-import-bug | typical | 3/3 | complete, complete, complete | 8/8/7 | 1/0/0 | 0.0028 | 15 |
| cli-flags-feature | typical | 3/3 | complete, complete, complete | 21/10/17 | 1/0/1 | 0.0082 | 43 |
| callbacks-to-async | typical | 3/3 | complete, complete, complete | 18/17/13 | 3/1/2 | 0.0095 | 55 |
| concurrency-limit-bug | typical | 3/3 | partial, partial, partial | 12/11/18 | 4/5/7 | 0.0040 | 26 |
| merge-conflict-resolution | typical | 3/3 | complete, complete, complete | 8/17/6 | 1/5/0 | 0.0032 | 16 |
