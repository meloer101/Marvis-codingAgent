const DEFAULTS = {
  title: 'Monthly report',
  locale: 'en-US',
  currency: 'USD',
};

const DEFAULT_COLUMNS = ['date', 'label', 'amount'];

function numberFormat(locale) {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A printable summary of ledger rows: heading, one line per row, and the total. */
export function buildReport(rows, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const number = numberFormat(options.locale);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return {
    heading: `${options.title} (${options.currency})`,
    lines: rows.map((row) => `${row.date}  ${row.label}  ${number.format(row.amount)}`),
    total: number.format(total),
  };
}

/** Rows as a table for CSV export: a header row, then one array per row. */
export function toTable(rows, opts = {}) {
  const columns = [...(opts.columns || DEFAULT_COLUMNS), ...(opts.extraColumns || [])];
  return [columns, ...rows.map((row) => columns.map((c) => row[c] ?? ''))];
}
