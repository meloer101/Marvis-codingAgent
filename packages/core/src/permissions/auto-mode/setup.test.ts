import { describe, expect, it } from 'vitest';

import { appendCustomRule, parseEnvironmentDraft } from './setup.js';

describe('parseEnvironmentDraft', () => {
  it('reads a JSON array, ignoring surrounding prose', () => {
    const text = 'Here you go:\n["Trusted repo: git@ex.com/app.git", "Cloud provider(s): none"]\n';
    expect(parseEnvironmentDraft(text)).toEqual([
      'Trusted repo: git@ex.com/app.git',
      'Cloud provider(s): none',
    ]);
  });

  it('falls back to Label: value lines', () => {
    expect(parseEnvironmentDraft('- Organization: Acme\nCloud provider(s): AWS\n')).toEqual([
      'Organization: Acme',
      'Cloud provider(s): AWS',
    ]);
  });
});

describe('appendCustomRule', () => {
  it('inserts $defaults on the first add', () => {
    expect(appendCustomRule(undefined, 'Org: us')).toEqual(['$defaults', 'Org: us']);
    expect(appendCustomRule([], 'Org: us')).toEqual(['$defaults', 'Org: us']);
  });

  it('appends to an existing list without forcing $defaults again', () => {
    expect(appendCustomRule(['only custom'], 'Org: us')).toEqual(['only custom', 'Org: us']);
    expect(appendCustomRule(['$defaults'], 'Org: us')).toEqual(['$defaults', 'Org: us']);
  });
});
