/**
 * Talking to an `marvis web` that is already running — how `marvis web` in another
 * directory adds that directory to it instead of starting a second server.
 * One short-lived socket per call, authenticated like any page.
 */

import type { MethodName, MethodParams, MethodResult, ServerFrame } from '@harness-code/protocol';
import { WebSocket } from 'ws';

/** Call one RPC method on the server at `port` and close. Rejects with the server's error message. */
export function callRunningServer<M extends MethodName>(
  port: number,
  token: string,
  method: M,
  params: MethodParams<M>,
  timeoutMs = 10_000,
): Promise<MethodResult<M>> {
  const origin = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    const timer = setTimeout(() => finish(new Error(`no answer from marvis web on port ${port}`)), timeoutMs);
    let done = false;
    const finish = (err: Error | null, result?: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(result as MethodResult<M>);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'req', id: 1, method: 'auth', params: { token } }));
      ws.send(JSON.stringify({ t: 'req', id: 2, method, params }));
    });
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      if (frame.t !== 'res') return;
      if (!frame.ok) finish(new Error(frame.error.message));
      else if (frame.id === 2) finish(null, frame.result);
    });
    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(new Error('marvis web closed the connection')));
  });
}
