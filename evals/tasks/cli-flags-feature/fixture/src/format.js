const COLUMNS = [
  { title: 'TIME (UTC)', width: 21, value: (e) => String(e.ts ?? '').replace('T', ' ').slice(0, 19) },
  { title: 'LEVEL', width: 7, value: (e) => String(e.level ?? '').toUpperCase() },
  { title: 'SERVICE', width: 10, value: (e) => String(e.svc ?? '') },
  { title: 'MESSAGE', width: 0, value: (e) => String(e.msg ?? '') },
];

function cell(text, width) {
  if (width === 0) return text;
  if (text.length < width) return text.padEnd(width);
  return `${text.slice(0, width - 2)}… `;
}

export function formatTable(events) {
  const rows = [COLUMNS.map((c) => c.title), ...events.map((e) => COLUMNS.map((c) => c.value(e)))];
  return rows.map((row) => row.map((text, i) => cell(text, COLUMNS[i].width)).join('').trimEnd()).join('\n') + '\n';
}
