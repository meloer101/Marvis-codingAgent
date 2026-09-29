/**
 * `/auto-mode-setup` overlay and the one-shot hint after several auto-mode
 * blocks. Their choices are `SelectMenu`s, which own the keys while open.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { AgentSession } from '@harness-code/core';

import type { Theme } from '../theme.js';
import { SelectMenu } from './select.js';

export function AutoModeSetupOverlay({
  session,
  theme,
  onClose,
}: {
  session: AgentSession;
  theme: Theme;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'saving'>('loading');
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void session
      .draftAutoModeEnvironment()
      .then((lines) => {
        if (cancelled) return;
        setDraft(lines);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Only while there is no menu to take Esc (loading / error / saving).
  useInput((_input, key) => {
    if (key.escape) onClose();
  }, { isActive: status !== 'ready' });

  const save = (): void => {
    setStatus('saving');
    void session.patchUserAutoMode({ environment: draft }).then(onClose);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>auto-mode setup</Text>
      {status === 'loading' && <Text color={theme.dim}>drafting environment from README / remotes…</Text>}
      {status === 'error' && <Text color={theme.error}>{error}</Text>}
      {(status === 'ready' || status === 'saving') && (
        <Box flexDirection="column">
          {draft.length === 0 && <Text color={theme.dim}>(model returned no environment lines)</Text>}
          {draft.slice(0, 16).map((line) => (
            <Text key={line}>{line.slice(0, 100)}</Text>
          ))}
          {draft.length > 16 && <Text color={theme.dim}>… {draft.length - 16} more</Text>}
        </Box>
      )}
      {status === 'ready' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Write this to ~/.agent/settings.json?</Text>
          <SelectMenu
            options={[
              { value: 'save', label: 'Yes' },
              { value: 'cancel', label: 'No', hint: '(esc)' },
            ]}
            theme={theme}
            onSelect={(v) => (v === 'save' ? save() : onClose())}
            onCancel={onClose}
          />
        </Box>
      ) : (
        <Text color={theme.dim}>{status === 'saving' ? 'saving…' : 'Esc to close'}</Text>
      )}
    </Box>
  );
}

export function AutoModeSetupHint({
  theme,
  onSetup,
  onDismiss,
  onClose,
}: {
  theme: Theme;
  onSetup: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold>auto mode</Text>
      <Text>Several actions were blocked. Draft environment rules so the classifier knows this repo?</Text>
      <Box marginTop={1}>
        <SelectMenu
          options={[
            { value: 'setup', label: 'Yes, run /auto-mode-setup' },
            { value: 'dismiss', label: "No, and don't show this again" },
            { value: 'later', label: 'Not now', hint: '(esc)' },
          ]}
          theme={theme}
          onSelect={(v) => (v === 'setup' ? onSetup() : v === 'dismiss' ? onDismiss() : onClose())}
          onCancel={onClose}
        />
      </Box>
    </Box>
  );
}
