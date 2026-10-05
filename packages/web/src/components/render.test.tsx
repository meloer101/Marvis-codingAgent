import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { EffortPicker, ModeChip, ModelPicker } from './ComposerControls';
import { toolPreview, toolView } from './tools/registry';
import { editDiff, writeDiff } from '@/lib/diff';
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
  it('edit: summary is the path, body is a diff, folded unless the edit failed', async () => {
    const view = toolView({
      id: 't',
      name: 'edit',
      input: { path: 'src/a.ts', oldString: 'const a = 1;', newString: 'const a = 2;' },
      running: false,
      result: { content: 'ok' },
    });
    expect(view.defaultOpen).toBe(false);
    const write = (isError?: true) =>
      toolView({ id: 't', name: 'write', input: { path: 'a.json', content: '{}' }, running: false, result: { content: 'x', ...(isError ? { isError } : {}) } });
    expect(write().defaultOpen).toBe(false);
    expect(write(true).defaultOpen).toBe(true);
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

  it('bash: a long output is folded unless the command failed; a short one shows', () => {
    const short = toolView({ id: 't', name: 'bash', input: { command: 'ls' }, running: false, result: { content: 'a' } });
    const long = 'x\n'.repeat(30);
    const ok = toolView({ id: 't', name: 'bash', input: { command: 'ls' }, running: false, result: { content: long } });
    const bad = toolView({
      id: 't',
      name: 'bash',
      input: { command: 'false' },
      running: false,
      result: { content: 'boom', isError: true },
    });
    expect(short.defaultOpen).toBe(true);
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

  it("shows a write over a file as what changed in it, ask and card alike", async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = before.replace('line 10\n', 'line ten\n');
    const { container } = render(<>{toolPreview('write', { path: 'a.txt', content: after }, { before })}</>);
    await screen.findByText('replaces the file');
    expect(container.textContent).toContain('@@ -7,7 +7,7 @@');
    expect(container.textContent).not.toContain('line 1line 2'); // only the hunk, not the whole file
    cleanup();

    const view = toolView({
      id: 'w',
      name: 'write',
      input: { path: 'a.txt', content: after },
      running: false,
      result: { content: 'Wrote', display: { before } },
    });
    const card = render(<>{view.body}</>);
    expect(await card.findByText('@@ -7,7 +7,7 @@')).toBeTruthy();
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

/** Radix opens its menus on pointerdown. */
function openMenu(label: string): void {
  fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

describe('EffortPicker', () => {
  it('offers the model levels, smartest first, and nothing for a model without reasoning', async () => {
    const picked: string[] = [];
    render(<EffortPicker effort="high" levels={['low', 'high', 'max']} onChange={(e) => picked.push(e)} />);
    expect(screen.getByLabelText('Reasoning effort').textContent).toBe('High');
    openMenu('Reasoning effort');
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Max', 'High', 'Low']);
    expect(items[1]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items[0]!);
    expect(picked).toEqual(['max']);
    cleanup();
    render(<EffortPicker effort={undefined} levels={[]} onChange={() => {}} />);
    expect(screen.queryByLabelText('Reasoning effort')).toBeNull();
  });

  it('still shows a current level the picker does not offer', async () => {
    render(<EffortPicker effort="off" levels={['low', 'high']} onChange={() => {}} />);
    openMenu('Reasoning effort');
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['High', 'Low', 'Off']);
  });
});

describe('ModeChip', () => {
  it('shows the mode and switches to another on offer', async () => {
    const picked: string[] = [];
    render(<ModeChip mode="ask" modes={['ask', 'acceptEdits', 'plan']} onChange={(m) => picked.push(m)} />);
    expect(screen.getByLabelText('Permission mode').textContent).toBe('Ask');
    openMenu('Permission mode');
    const items = await screen.findAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    fireEvent.click(await screen.findByText('Plan'));
    expect(picked).toEqual(['plan']);
  });
});

describe('ModelPicker', () => {
  it('lists the models with their window and price; one without a key cannot be picked', async () => {
    const picked: string[] = [];
    let opened = 0;
    render(
      <ModelPicker
        modelRef="deepseek/deepseek-flash"
        models={[
          {
            ref: 'deepseek/deepseek-flash',
            contextWindow: 1_000_000,
            qualityContextWindow: 256_000,
            maxOutputTokens: 384_000,
            effortLevels: ['high'],
            pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
          },
          { ref: 'deepseek/deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 1, effortLevels: [] },
          { ref: 'openai/gpt-5', contextWindow: 200_000, maxOutputTokens: 1, effortLevels: [], problem: 'OpenAI needs an API key.' },
        ]}
        onOpen={() => opened++}
        onChange={(m) => picked.push(m)}
      />,
    );
    expect(screen.getByLabelText('Model').textContent).toContain('deepseek-flash');
    openMenu('Model');
    expect(opened).toBe(1);
    expect(await screen.findByText('1M context · 256K reliable · reasoning')).toBeTruthy();
    expect(screen.getByText('$0.30 / $1.20')).toBeTruthy();
    fireEvent.click(screen.getByText('openai/gpt-5'));
    fireEvent.click(screen.getByText('deepseek/deepseek-v4-pro'));
    expect(picked).toEqual(['deepseek/deepseek-v4-pro']);
  });

  it('cannot be opened while a run is going', () => {
    render(<ModelPicker modelRef="m/x" models={[]} onOpen={() => {}} onChange={() => {}} disabledReason="busy" />);
    expect((screen.getByLabelText('Model') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('hidden notices', () => {
  it('mode and effort changes, and sub-agent progress lines, get no transcript row', () => {
    const notice = (id: number, kind: string, text: string) =>
      ({ kind: 'notice', id, notice: { kind, level: 'info', text } }) as never;
    const rows = transcriptRows([
      notice(0, 'mode-changed', 'mode: ask → plan'),
      notice(1, 'effort-changed', 'effort: high → max'),
      notice(2, 'context-warn', 'context 81% full'),
      notice(3, 'subagent', '  ⤷ explore: read {"path":"a.ts"}'),
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('DiffView', () => {
  const lineNos = (container: HTMLElement) =>
    [...container.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td.tabular-nums')].map((td) => td.textContent));

  it("numbers an edit's lines from where it starts in the file, and marks the changed words", () => {
    const { container } = render(<DiffView diff={editDiff('keep\nconst a = 1;\n', 'keep\nconst b = 1;\n', 10)} />);
    expect(lineNos(container)).toEqual([
      ['10', '10'],
      ['11', ''],
      ['', '11'],
    ]);
    expect([...container.querySelectorAll('.bg-destructive\\/25, .bg-success\\/25')].map((e) => e.textContent)).toEqual(['a', 'b']);
  });

  it('gives a new file one number column, and shows a long one in full on request', () => {
    const content = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
    const { container } = render(<DiffView diff={writeDiff(content)} />);
    expect(lineNos(container)[0]).toEqual(['1']);
    expect(container.querySelectorAll('tr')).toHaveLength(400);
    fireEvent.click(screen.getByRole('button', { name: /Show all 450 lines/ }));
    expect(container.querySelectorAll('tr')).toHaveLength(450);
    expect(container.textContent).toContain('line 450');
  });

  it('colours the code once its grammar loads', async () => {
    render(<DiffView diff={editDiff('let x = 1;', 'let x = 2;')} lang="ts" />);
    // Both sides (the removed and the added line) start with a coloured `let`.
    const kws = await screen.findAllByText('let', { selector: 'span' });
    expect(kws).toHaveLength(2);
    for (const kw of kws) expect(kw.style.getPropertyValue('--shiki-light')).toMatch(/^#/);
  });
});
