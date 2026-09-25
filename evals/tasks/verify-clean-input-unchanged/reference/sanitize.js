const { readFileSync, writeFileSync } = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node sanitize.js <file.html>');
  process.exit(2);
}
const before = readFileSync(file, 'utf8');
const after = before.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
if (after !== before) writeFileSync(file, after);
