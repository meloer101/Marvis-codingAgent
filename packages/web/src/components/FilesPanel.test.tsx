import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DirEntry, FileContent } from '@harness-code/protocol';

import { FilesPanel } from './FilesPanel';
import { toolView } from './tools/registry';
import { openFile, setPanel, useOpenedFile, usePanel } from '@/lib/panel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';


const W1 = { workspaceId: 'w1', root: '/proj' };
afterEach(() => {
  cleanup();
  act(() => {
    openFile(null);
    setPanel(null);
  });
  useAppStore.setState({ info: null, workspaces: [], gitRev: {} });
});

const tree: Record<string, DirEntry[]> = {
  '': [
    { name: 'src', dir: true },
    { name: 'README.md', dir: false },
  ],
  src: [{ name: 'a.ts', dir: false }],
};

function renderPanel(file: FileContent = { kind: 'text', content: 'const a = 1;\nconst b = 2;\n' }) {
  const sync = {
    listDir: vi.fn(async (_c: unknown, dir: string) => tree[dir] ?? []),
    readFile: vi.fn(async () => file),
    searchFiles: vi.fn(async () => [{ path: 'src/a.ts' }]),
    openInEditor: vi.fn(async () => {}),
  };
  useAppStore.setState({
    workspaces: [{ id: 'w1', root: '/proj', name: 'proj', projectRoot: '/proj', lastUsedAt: 0, defaults: {} as never }],
    info: { editors: [{ id: 'vscode', name: 'VS Code' }] } as never,
  });
  render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <FilesPanel checkout={W1} />
    </SyncProvider>,
  );
  return sync;
}

describe('FilesPanel', () => {
  it('lists the project a folder at a time and opens a file in the viewer', async () => {
    const sync = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /src/ }));
    expect(sync.listDir).toHaveBeenCalledWith(W1, 'src');
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    expect(await screen.findByText('src/a.ts')).toBeTruthy(); // the viewer's header
    expect(sync.readFile).toHaveBeenCalledWith(W1, 'src/a.ts');
    expect((await screen.findAllByRole('row')).map((r) => r.textContent)).toEqual(['1const a = 1;', '2const b = 2;']);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the files' }));
    expect(await screen.findByRole('button', { name: /README\.md/ })).toBeTruthy();
  });

  it('finds files by name', async () => {
    const sync = renderPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a file' }), { target: { value: 'a.ts' } });
    expect(await screen.findByRole('button', { name: 'src/a.ts' })).toBeTruthy();
    expect(sync.searchFiles).toHaveBeenCalledWith(W1, 'a.ts');
  });

  it('opens an absolute path from a tool call relative to the project, in an editor at its line', async () => {
    const sync = renderPanel();
    act(() => openFile('/proj/src/a.ts', 2));
    await screen.findByText('src/a.ts');
    expect(sync.readFile).toHaveBeenCalledWith(W1, 'src/a.ts');
    await screen.findAllByRole('row');
    expect(document.querySelector('[data-line="2"]')!.className).toContain('bg-primary/10');
    fireEvent.click(screen.getByRole('button', { name: /VS Code/ }));
    expect(sync.openInEditor).toHaveBeenCalledWith(W1, 'src/a.ts', 'vscode', 2);
  });

  it('says why a file is not shown', async () => {
    renderPanel({ kind: 'withheld', reason: 'This looks like a secret, so its contents stay on disk.' });
    act(() => openFile('.env'));
    expect(await screen.findByText(/looks like a secret/)).toBeTruthy();
  });
});

describe('opening a file from a tool card', () => {
  function Probe() {
    const opened = useOpenedFile();
    const panel = usePanel();
    return <p data-testid="probe">{`${panel}:${opened?.path}:${opened?.line}`}</p>;
  }

  it('opens an edit at the line it starts on, in the Files tab', () => {
    const view = toolView({
      id: 'e',
      name: 'edit',
      input: { path: 'src/a.ts', oldString: 'a', newString: 'b' },
      running: false,
      result: { content: 'Replaced 1 occurrence(s)', display: { startLine: 14 } },
    });
    render(
      <>
        {view.body}
        <Probe />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open file at line 14' }));
    expect(screen.getByTestId('probe').textContent).toBe('files:src/a.ts:14');
  });
});
