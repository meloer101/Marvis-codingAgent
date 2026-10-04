import { describe, expect, it } from 'vitest';

import { loginShell, parseShellEnv, readLoginShellEnv } from './shell-env.js';

const MARK = '__MARVIS_SHELL_ENV__';

describe('parseShellEnv', () => {
  it('reads env -0 output between the marks, ignoring what the profile prints', () => {
    const out = `Welcome back!\n${MARK}PATH=/opt/homebrew/bin:/usr/bin\0KEY=a=b\0MULTI=one\ntwo\0${MARK}bye`;
    expect(parseShellEnv(out)).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', KEY: 'a=b', MULTI: 'one\ntwo' });
  });

  it('drops per-shell variables', () => {
    expect(parseShellEnv(`${MARK}PWD=/x\0SHLVL=2\0_=/usr/bin/env\0HOME=/h\0${MARK}`)).toEqual({ HOME: '/h' });
  });

  it('is null without both marks', () => {
    expect(parseShellEnv('PATH=/usr/bin')).toBeNull();
    expect(parseShellEnv(`${MARK}PATH=/usr/bin`)).toBeNull();
  });
});

describe('loginShell', () => {
  it('prefers $SHELL', () => {
    expect(loginShell({ SHELL: '/usr/local/bin/fish' })).toBe('/usr/local/bin/fish');
  });
});

describe.skipIf(process.platform === 'win32')('readLoginShellEnv', () => {
  it("reads a real login shell's environment", async () => {
    const env = await readLoginShellEnv();
    expect(env?.['PATH']).toBeTruthy();
  });
});
