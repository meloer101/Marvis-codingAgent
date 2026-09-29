import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';
import { toolPreview, toolView } from './tools/registry';
import { briefNotice, transcriptRows } from '@/lib/rows';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders GFM: emphasis, lists, inline code, tables', async () => {
    const { container } = render(
      <Markdown text={'**bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />,
    );
    // Markdown lazily loads MarkdownBody (code-split out of the main bundle) behind a
    // Suspense boundary; wait for it to resolve before asserting on parsed content.
    await screen.findByText('bold');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('table td')?.textContent).toBe('1');
  });

  it('renders fenced code as a code block, closing a dangling fence mid-stream', async () => {
    const { container } = render(<Markdown text={'look:\n```ts\nconst a = 1;'} streaming />);
    await screen.findByText('ts'); // language label; only present once MarkdownBody resolves
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('const a = 1;');
    expect(screen.getByText('ts')).toBeTruthy(); // language label
    // The rest didn't get swallowed into the code block.
    expect(container.querySelector('p')?.textContent).toBe('look:');
  });

  it('closes emphasis between CJK punctuation and text, where CommonMark leaves the markers raw', async () => {
    const { container } = render(
      <Markdown text={'**注意：**这个文件会被覆盖，这是**「重点」**内容，~~旧的：~~新的'} />,
    );
    await screen.findByText('注意：');
    expect([...container.querySelectorAll('strong')].map((n) => n.textContent)).toEqual(['注意：', '「重点」']);
    expect(container.querySelector('del')?.textContent).toBe('旧的：');
    expect(container.textContent).not.toContain('*');
  });

  it('does not render raw HTML from the model', () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)">hi'} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('tool renderers', () => {
  it('edit: summary is the path, body is a diff, small diffs open by default', async () => {
    const view = toolView({
      id: 't',
      name: 'edit',
      input: { path: 'src/a.ts', oldString: 'const a = 1;', newString: 'const a = 2;' },
      running: false,
      result: { content: 'ok' },
    });
    expect(view.defaultOpen).toBe(true);
    const { container } = render(
      <>
        {view.summary}
        {view.meta}
        {view.body}
      </>,
    );
    expect(container.textContent).toContain('src/a.ts');
    // meta/body are lazy-loaded (EditDiffMeta/EditDiffPanel, code-split via diffPanels.tsx).
    await screen.findByText('+1');
    expect(container.textContent).toContain('+1');
    expect(container.textContent).toContain('const a = 2;');
  });

  it('bash: output is folded unless the command failed', () => {
    const ok = toolView({ id: 't', name: 'bash', input: { command: 'ls' }, running: false, result: { content: 'a' } });
    const bad = toolView({
      id: 't',
      name: 'bash',
      input: { command: 'false' },
      running: false,
      result: { content: 'boom', isError: true },
    });
    expect(ok.defaultOpen).toBe(false);
    expect(bad.defaultOpen).toBe(true);
  });

  it('todo: counts completed items', () => {
    const view = toolView({
      id: 't',
      name: 'todo',
      input: {
        todos: [
          { id: '1', content: 'a', status: 'completed' },
          { id: '2', content: 'b', status: 'in_progress' },
        ],
      },
      running: false,
    });
    expect(view.summary).toBe('1/2 done');
  });

  it('falls back to a generic view for unknown (e.g. MCP) tools', () => {
    const view = toolView({ id: 't', name: 'github__search', input: { q: 'x' }, running: false });
    const { container } = render(<>{view.body}</>);
    expect(container.textContent).toContain('"q": "x"');
  });

  it('previews an edit ask as a diff', async () => {
    const { container } = render(
      <>{toolPreview('edit', { path: 'docs/a.md', oldString: 'old line', newString: 'new line' })}</>,
    );
    // The whole preview (EditPreviewPanel, including the path) is behind one Suspense
    // boundary in toolPreview, so nothing is visible until the lazy chunk resolves.
    await screen.findByText('docs/a.md');
    expect(container.textContent).toContain('docs/a.md');
    expect(container.textContent).toContain('old line');
    expect(container.textContent).toContain('new line');
  });
});

describe('startup notices', () => {
  it('fold into one session-details line; other notices stay rows of their own', () => {
    const notice = (id: number, kind: string, text: string, level = 'info') =>
      ({ kind: 'notice', id, notice: { kind, level, text } }) as never;
    const rows = transcriptRows([
      notice(0, 'skills-discovered', 'skills: 2 discovered (project 0, user 0, builtin 2)'),
      notice(1, 'mcp-status', 'mcp: 1/1 server ready, 68 tools'),
      notice(2, 'session-start', 'session abc · cwd /w · m · mode ask'),
      { kind: 'user', id: 3, text: 'hi' } as never,
      notice(4, 'context-warn', 'context 81% full', 'warn'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['details', 'entry', 'entry']);
    const details = rows[0]!;
    expect(details.kind === 'details' && details.notices.map(briefNotice)).toEqual(['skills 2', 'mcp 1/1 ready', null]);
  });
});
