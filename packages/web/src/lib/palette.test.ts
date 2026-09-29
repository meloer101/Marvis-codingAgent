import { describe, expect, it } from 'vitest';

import { filterPalette, paletteScore } from './palette';
import type { PaletteItem } from './palette';

const item = (id: string, group: PaletteItem['group'], label: string, keywords?: string): PaletteItem => ({
  id,
  group,
  label,
  ...(keywords ? { keywords } : {}),
  run: () => {},
});

describe('paletteScore', () => {
  it('needs every word, preferring whole words at a start', () => {
    expect(paletteScore('Mode: Plan permission mode', 'mode plan')).not.toBeNull();
    expect(paletteScore('Mode: Plan', 'mode yolo')).toBeNull();
    expect(paletteScore('New session', 'nss')).not.toBeNull(); // a subsequence
    expect(paletteScore('Model: openai/gpt-5', 'gpt')!).toBeGreaterThan(paletteScore('Fix the flaky tests in prompt', 'gpt') ?? -Infinity);
  });
});

describe('filterPalette', () => {
  const items = [
    item('new', 'New', 'New session'),
    item('rename', 'This session', 'Rename session'),
    ...Array.from({ length: 9 }, (_, i) => item(`s${i}`, 'Sessions', `session number ${i}`)),
    item('theme', 'App', 'Theme: Dark', 'appearance'),
  ];

  it('lists every group without a query, but only the recent sessions', () => {
    const shown = filterPalette(items, '');
    expect(shown.filter((i) => i.group === 'Sessions')).toHaveLength(6);
    expect(shown[0]!.id).toBe('new');
    expect(shown.at(-1)!.id).toBe('theme');
  });

  it('with a query, lists every match best first, keywords included', () => {
    expect(filterPalette(items, 'number 8').map((i) => i.id)).toEqual(['s8']);
    expect(filterPalette(items, 'appearance').map((i) => i.id)).toEqual(['theme']);
    expect(filterPalette(items, 'rename').map((i) => i.id)).toEqual(['rename']);
  });
});
