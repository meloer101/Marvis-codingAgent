import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Derived from Terminal-Bench's filter-js-from-html, where the agent checked
// "clean input is left alone" on the one clean document it wrote itself and
// changed 5 of the 12 the grader used. The samples here are just as thin; the
// requirement is stated plainly, and these are the files it is checked on.
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const dir = mkdtempSync(join(tmpdir(), 'verify-clean-'));
const run = (name, content) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  try {
    execFileSync('node', ['sanitize.js', p], { stdio: 'pipe', timeout: 10_000 });
  } catch (err) {
    fail(`node sanitize.js ${name} failed: ${err.stderr?.toString() ?? err}`);
  }
  return readFileSync(p, 'utf8');
};

const clean = {
  'crlf.html': '<html>\r\n<body>\r\n<p>Windows line endings</p>\r\n</body>\r\n</html>\r\n',
  'no-final-newline.html': '<html><body><p>no newline at the end</p></body></html>',
  'unicode.html': '<p>Café — 中文 — naïve</p>\n',
  'mentions-script.html': '<p>The script ran &lt;script&gt; fine; see the manuscript.</p>\n',
  'noscript.html': '<noscript><p>Enable JavaScript</p></noscript>\n',
  'indented.html': '<div>\n\t<p>  spaced   out  </p>\n\n\n</div>\n',
};
for (const [name, content] of Object.entries(clean)) {
  const after = run(name, content);
  if (after !== content) fail(`${name} has no script element but was changed: ${JSON.stringify(after)}`);
}

const dirty = {
  'upper.html': ['<P>a</P><SCRIPT>alert(1)</SCRIPT><P>b</P>\n', '<P>a</P><P>b</P>\n'],
  'attrs.html': ['<p>a</p><script type="module" src="x.js"></script>\n', '<p>a</p>\n'],
  'multiline.html': ['<p>a</p>\n<script>\n  let x = 1;\n  alert(x);\n</script>\n<p>b</p>\n', '<p>a</p>\n\n<p>b</p>\n'],
};
for (const [name, [content, want]] of Object.entries(dirty)) {
  const after = run(name, content);
  if (/<script/i.test(after) || /alert/.test(after)) fail(`${name} still has a script: ${JSON.stringify(after)}`);
  if (after !== want) fail(`${name}: removing the script changed other content: ${JSON.stringify(after)}`);
}

console.log('scripts removed; files without scripts left byte-for-byte unchanged');
