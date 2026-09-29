import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 解析上游推送的交易明细（id,account,amount,date）。 */
export function parseTransactions(text) {
  const [header, ...lines] = text.trim().split('\n');
  const columns = header.split(',');
  return lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const values = line.split(',');
      return Object.fromEntries(columns.map((column, i) => [column, values[i]]));
    });
}

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * 按账户汇总，单位为分。上游偶尔会把同一笔交易重复推送，所以每个 id 只算一次。
 */
export function totalsByAccount(transactions) {
  const seen = new Set();
  const totals = new Map();
  for (const tx of transactions) {
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    const cents = toCents(tx.amount);
    if (Number.isNaN(cents)) continue;
    totals.set(tx.account, (totals.get(tx.account) ?? 0) + cents);
  }
  return totals;
}

/** 输出格式与财务导出的 finance/export.csv 相同。 */
export function formatTotals(totals) {
  const lines = ['account,total'];
  for (const account of [...totals.keys()].sort()) {
    lines.push(`${account},${(totals.get(account) / 100).toFixed(2)}`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'data/transactions.csv';
  process.stdout.write(formatTotals(totalsByAccount(parseTransactions(readFileSync(file, 'utf8')))));
}
