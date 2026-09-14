/**
 * `/auto-mode-setup` overlay and the one-shot hint after several auto-mode
 * blocks. Own their input while open.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { AgentSession } from '@harness-code/core';

import type { Theme } from '../theme.js';

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

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (status !== 'ready') return;
    if (input === 'y' || key.return) {
      setStatus('saving');
      void session.patchUserAutoMode({ environment: draft }).then(onClose);
    }
  });

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
      <Text color={theme.dim}>
        {status === 'ready' ? '[y] write to ~/.agent/settings.json  [Esc] cancel' : '[Esc] close'}
      </Text>
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
  useInput((input, key) => {
    if (key.escape) onClose();
    else if (input === 'y') onSetup();
    else if (input === 'd') onDismiss();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold>auto mode</Text>
      <Text>Several actions were blocked. Draft environment rules so the classifier knows this repo?</Text>
      <Text color={theme.dim}>[y] /auto-mode-setup  [d] don&apos;t show again  [Esc] later</Text>
    </Box>
  );
}
