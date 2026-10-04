import { describe, expect, it } from 'vitest';

import { panesOf, parseRoute, routeShowing, routeToHash } from './route';

describe('parseRoute', () => {
  it('treats empty, root and unknown hashes as home', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' });
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/nope')).toEqual({ kind: 'home' });
  });

  it('does not mistake the token fragment for a route', () => {
    expect(parseRoute('#token=abc123')).toEqual({ kind: 'home' });
  });

  it('parses a session route, with or without a trailing slash', () => {
    expect(parseRoute('#/s/abc')).toEqual({ kind: 'session', id: 'abc' });
    expect(parseRoute('#/s/abc/')).toEqual({ kind: 'session', id: 'abc' });
  });

  it('round-trips ids that need encoding', () => {
    const route = { kind: 'session', id: '2026-09-11 a/b' } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });
});

describe('new-session routes', () => {
  it('parses and builds a draft in a given workspace', () => {
    expect(parseRoute('#/new/0f1e2d3c4b5a')).toEqual({ kind: 'new', workspaceId: '0f1e2d3c4b5a' });
    expect(routeToHash({ kind: 'new', workspaceId: '0f1e2d3c4b5a' })).toBe('#/new/0f1e2d3c4b5a');
    expect(routeToHash({ kind: 'home' })).toBe('#/');
  });
});

describe('split view', () => {
  it('parses and builds two sessions side by side; the same one twice is one', () => {
    expect(parseRoute('#/s/a/b')).toEqual({ kind: 'session', id: 'a', split: 'b' });
    expect(parseRoute('#/s/a/a')).toEqual({ kind: 'session', id: 'a' });
    expect(routeToHash({ kind: 'session', id: 'a', split: 'b' })).toBe('#/s/a/b');
    expect(panesOf(parseRoute('#/s/a/b'))).toEqual(['a', 'b']);
    expect(panesOf({ kind: 'home' })).toEqual([]);
  });

  it('puts a session in a pane, keeping the other', () => {
    const single = parseRoute('#/s/a');
    const split = parseRoute('#/s/a/b');
    expect(routeShowing(single, 'c', 1)).toEqual({ kind: 'session', id: 'a', split: 'c' });
    expect(routeShowing(single, 'c', 0)).toEqual({ kind: 'session', id: 'c' });
    expect(routeShowing(split, 'c', 0)).toEqual({ kind: 'session', id: 'c', split: 'b' });
    expect(routeShowing(split, 'c', 1)).toEqual({ kind: 'session', id: 'a', split: 'c' });
    // Opening beside itself is just itself.
    expect(routeShowing(single, 'a', 1)).toEqual({ kind: 'session', id: 'a' });
    expect(routeShowing({ kind: 'home' }, 'c', 1)).toEqual({ kind: 'session', id: 'c' });
  });
});

describe('the usage page', () => {
  it('parses and builds #/stats', () => {
    expect(parseRoute('#/stats')).toEqual({ kind: 'stats' });
    expect(routeToHash({ kind: 'stats' })).toBe('#/stats');
  });
});

describe('the settings page', () => {
  it('parses and builds #/settings/<section>, the first section by default', () => {
    expect(parseRoute('#/settings')).toEqual({ kind: 'settings', section: 'permissions' });
    expect(parseRoute('#/settings/mcp')).toEqual({ kind: 'settings', section: 'mcp' });
    expect(parseRoute('#/settings/skills')).toEqual({ kind: 'settings', section: 'skills' });
    expect(parseRoute('#/settings/agents')).toEqual({ kind: 'settings', section: 'agents' });
    expect(parseRoute('#/settings/doctor')).toEqual({ kind: 'settings', section: 'doctor' });
    expect(parseRoute('#/settings/nope')).toEqual({ kind: 'settings', section: 'permissions' });
    expect(routeToHash({ kind: 'settings', section: 'auto-mode' })).toBe('#/settings/auto-mode');
  });
});
