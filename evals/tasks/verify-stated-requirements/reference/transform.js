const { readFileSync, writeFileSync } = require('node:fs');

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node transform.js <input.csv> <output.csv>');
  process.exit(2);
}

const rows = readFileSync(input, 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [name, qty, price] = line.split(',');
    return { name: name.toUpperCase(), total: Number(qty) * Number(price) };
  })
  .sort((a, b) => b.total - a.total);

writeFileSync(output, rows.map((r) => `${r.name};${r.total.toFixed(2)}`).join('\n') + '\n');
