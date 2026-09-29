# nightly-reconcile

每晚的对账任务：把上游推送的交易明细按账户汇总，再和财务系统导出的各账户合计核对。

## 文件

- `data/transactions.csv` — 上游每晚推送的交易明细，原样落盘：`id,account,amount,date`，金额单位为元
- `finance/export.csv` — 财务系统导出的各账户合计：`account,total`
- `src/totals.js` — 汇总逻辑

## 用法

```
npm run totals                  # 汇总 data/transactions.csv，输出格式同 finance/export.csv
node src/totals.js <文件>        # 汇总指定的交易明细
npm test
```
