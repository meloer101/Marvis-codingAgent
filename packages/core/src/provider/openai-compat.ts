/**
 * OpenAI Chat Completions provider.
 *
 * This one adapter is the substrate for DeepSeek, Moonshot/Kimi, Qwen via
 * DashScope, Zhipu, OpenRouter, Groq, Together, xAI, Mistral, a LiteLLM proxy,
 * Ollama, vLLM and llama.cpp. They all claim the same API; they differ in ways
 * that only show up in production. The differences absorbed here are documented
 * inline, because each one is a bug someone will otherwise rediscover.
 */

import { estimateCostUSD, mapEffort, resolveCapabilities } from './capabilities.js';
import type { CapabilityOverrides, ModelCapabilities } from './capabilities.js';
import { flattenRequestText, heuristicTokenCount } from '../context/tokenizer.js';
import type { TokenCounter } from '../context/tokenizer.js';
import { PromptToolParser, renderToolPrompt } from './prompt-tools.js';
import { DsmlSalvager, salvageBareToolCall } from './dsml-salvage.js';
import { backoffMs, sleep } from './retry.js';
import { parseSSE } from './sse.js';
import { parseLooseJSON } from '../util/json.js';
import {
  ProviderError,
  drainStream,
  emptyUsage,
} from './types.js';
import type {
  AssistantBlock,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
  StreamEvent,
  SystemSegment,
  ToolDefinition,
  ToolUseBlock,
  Usage,
} from './types.js';

export type { TokenCounter } from '../context/tokenizer.js';

export interface OpenAICompatConfig {
  /** Routing id (`deepseek`, `ollama`, ...). Also used in error messages. */
  id: string;
  /** Base URL including the version segment, e.g. `https://api.deepseek.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Extra headers, e.g. OpenRouter's attribution headers. */
  headers?: Record<string, string>;
  capabilityOverrides?: CapabilityOverrides;
  /** Injected for tests and for the record/replay provider. */
  fetchImpl?: typeof fetch;
  /**
   * How long to wait for response *headers*. Generous by default: a queued
   * request can sit a long time before the model starts.
   */
  timeoutMs?: number;
  /**
   * How long the body may go silent before the request is abandoned. Reset by
   * every chunk — including SSE keep-alive comments — so a long reasoning pause
   * that is still streaming keep-alives never trips it.
   */
  idleTimeoutMs?: number;
  maxRetries?: number;
  /** Used only when the endpoint reports no usage. Phase 4 injects a real one. */
  countTokens?: TokenCounter;
}

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  private readonly cfg: Required<
    Pick<OpenAICompatConfig, 'baseUrl' | 'timeoutMs' | 'idleTimeoutMs' | 'maxRetries'>
  > &
    OpenAICompatConfig;
  private readonly doFetch: typeof fetch;
  private readonly countTokens: TokenCounter;

  constructor(config: OpenAICompatConfig) {
    this.id = config.id;
    this.cfg = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      timeoutMs: config.timeoutMs ?? 600_000,
      idleTimeoutMs: config.idleTimeoutMs ?? 300_000,
      // DeepSeek's own harness retries each retryable class five times; the
      // backoff (500ms → 10s) keeps that from being a long stall.
      maxRetries: config.maxRetries ?? 5,
    };
    this.doFetch = config.fetchImpl ?? globalThis.fetch;
    this.countTokens = config.countTokens ?? heuristicTokenCount;
  }

  capabilities(model: string): ModelCapabilities {
    return resolveCapabilities(this.id, model, this.cfg.capabilityOverrides ?? {});
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const caps = this.capabilities(req.model);
    if (caps.streaming) return drainStream(this.stream(req));
    return this.completeNonStreaming(req, caps);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const caps = this.capabilities(req.model);
    if (!caps.streaming) {
      // Keep one code path for callers: synthesize a stream from one response.
      const res = await this.completeNonStreaming(req, caps);
      yield { type: 'message_start', model: res.model };
      for (const block of res.content) {
        if (block.type === 'text') yield { type: 'text_delta', text: block.text };
        else if (block.type === 'thinking')
          yield { type: 'thinking_delta', text: block.text };
      }
      let i = 0;
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        yield { type: 'tool_use_start', index: i, id: block.id, name: block.name };
        if (block.rawInput)
          yield { type: 'tool_use_delta', index: i, argsDelta: block.rawInput };
        yield { type: 'tool_use_end', index: i, block };
        i++;
      }
      yield { type: 'message_end', response: res };
      return;
    }
    yield* this.streamNative(req, caps);
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  private async *streamNative(
    req: ModelRequest,
    caps: ModelCapabilities,
  ): AsyncGenerator<StreamEvent> {
    const usePromptTools = !caps.nativeTools && (req.tools?.length ?? 0) > 0;
    const started = Date.now();
    let ttftMs: number | undefined;

    const { response, dispose, timeoutSignal, touch } = await this.requestCompletion(
      req,
      caps,
      true,
      usePromptTools,
    );
    if (!response.body) {
      dispose();
      throw new ProviderError('protocol', 'Streaming response had no body', {
        provider: this.id,
      });
    }
    // The reader watches both the caller's signal and the request deadline, so
    // a timeout mid-stream cancels it cleanly instead of surfacing as an
    // unhandled `TimeoutError`.
    const readSignal = req.signal
      ? AbortSignal.any([req.signal, timeoutSignal])
      : timeoutSignal;

    yield { type: 'message_start', model: req.model };

    const acc = new ToolCallAccumulator();
    const promptParser = usePromptTools ? new PromptToolParser() : undefined;
    const salvager = salvagerFor(req, caps, usePromptTools);
    let text = '';
    let thinking = '';
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let sawAnyChunk = false;
    let promptToolIndex = 0;
    const promptToolBlocks: ToolUseBlock[] = [];

    try {
      for await (const msg of parseSSE(response.body, readSignal, touch)) {
        if (msg.data === '[DONE]') break;

        const parsed = parseLooseJSON(msg.data);
        if (!parsed.ok) {
          // A malformed frame is not worth aborting a long turn over; note it
          // and keep reading. A truly broken stream fails the protocol check
          // below.
          continue;
        }
        const chunk = parsed.value as OpenAIStreamChunk;

        // Some gateways deliver errors inside the SSE stream with HTTP 200.
        if (chunk.error) {
          throw mapErrorPayload(chunk.error, this.id, undefined);
        }

        if (chunk.usage) usage = normalizeUsage(chunk.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        sawAnyChunk = true;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};

        // Reasoning channel: DeepSeek uses `reasoning_content`, OpenRouter and
        // a few others use `reasoning`.
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning !== '') {
          thinking += reasoning;
          ttftMs ??= Date.now() - started;
          yield { type: 'thinking_delta', text: reasoning };
        }

        const contentDelta = normalizeContentDelta(delta.content);
        if (contentDelta !== '') {
          ttftMs ??= Date.now() - started;
          if (promptParser) {
            const out = promptParser.push(contentDelta);
            if (out.text !== '') {
              text += out.text;
              yield { type: 'text_delta', text: out.text };
            }
            for (const block of out.calls) {
              const idx = promptToolIndex++;
              promptToolBlocks.push(block);
              yield { type: 'tool_use_start', index: idx, id: block.id, name: block.name };
              if (block.rawInput)
                yield { type: 'tool_use_delta', index: idx, argsDelta: block.rawInput };
              yield { type: 'tool_use_end', index: idx, block };
            }
          } else {
            const visible = salvager ? salvager.push(contentDelta) : contentDelta;
            if (visible !== '') {
              text += visible;
              yield { type: 'text_delta', text: visible };
            }
          }
        }

        if (delta.tool_calls) {
          ttftMs ??= Date.now() - started;
          for (const ev of acc.push(delta.tool_calls)) yield ev;
        }
      }
    } catch (err) {
      throw normalizeStreamError(err, req.signal, timeoutSignal, this.id, this.cfg.idleTimeoutMs);
    } finally {
      // Stream drained (or failed) — the deadline is no longer needed.
      dispose();
    }

    // `parseSSE` cancels its reader on abort, which ends the loop cleanly rather
    // than throwing — so an abort/timeout would otherwise surface as a silently
    // truncated completion. Catch that here.
    if (req.signal?.aborted || timeoutSignal.aborted) {
      throw normalizeStreamError(
        timeoutSignal.aborted && !req.signal?.aborted
          ? new DOMException('stream deadline', 'TimeoutError')
          : new DOMException('aborted', 'AbortError'),
        req.signal,
        timeoutSignal,
        this.id,
        this.cfg.idleTimeoutMs,
      );
    }

    if (promptParser) {
      const out = promptParser.end();
      if (out.text !== '') {
        text += out.text;
        yield { type: 'text_delta', text: out.text };
      }
      for (const block of out.calls) {
        const idx = promptToolIndex++;
        promptToolBlocks.push(block);
        yield { type: 'tool_use_start', index: idx, id: block.id, name: block.name };
        if (block.rawInput)
          yield { type: 'tool_use_delta', index: idx, argsDelta: block.rawInput };
        yield { type: 'tool_use_end', index: idx, block };
      }
    }

    if (!sawAnyChunk && !usage) {
      throw new ProviderError('protocol', 'Stream contained no completion chunks', {
        provider: this.id,
      });
    }

    const nativeBlocks: ToolUseBlock[] = [];
    for (const { index, block } of acc.finalize()) {
      yield { type: 'tool_use_end', index, block };
      nativeBlocks.push(block);
    }

    let toolBlocks = usePromptTools ? promptToolBlocks : nativeBlocks;
    let salvaged = 0;
    if (salvager) {
      const out = salvager.end(nativeBlocks.length > 0);
      if (out.calls.length === 0) {
        // Nothing recovered: whatever was held back is ordinary text after all.
        if (out.text !== '') {
          text += out.text;
          yield { type: 'text_delta', text: out.text };
        }
      } else {
        // The markup is gone; any prose that was held with it still shows.
        text = text.trimEnd();
        if (out.text !== '') {
          const piece = text === '' ? out.text : `\n${out.text}`;
          text += piece;
          yield { type: 'text_delta', text: piece };
        }
        for (const [idx, block] of out.calls.entries()) {
          yield { type: 'tool_use_start', index: idx, id: block.id, name: block.name };
          if (block.rawInput) yield { type: 'tool_use_delta', index: idx, argsDelta: block.rawInput };
          yield { type: 'tool_use_end', index: idx, block };
        }
        toolBlocks = out.calls;
        salvaged = out.calls.length;
      }
      // The markup-free variant can only be recognised once the text is final.
      // What streamed is already on screen; history gets the corrected turn.
      if (toolBlocks.length === 0 && (finishReason === 'stop' || finishReason === undefined)) {
        const bare = salvageBareToolCall(text, toolNameSet(req));
        if (bare) {
          text = bare.text;
          toolBlocks = bare.calls;
          salvaged = bare.calls.length;
          const block = bare.calls[0]!;
          yield { type: 'tool_use_start', index: 0, id: block.id, name: block.name };
          yield { type: 'tool_use_end', index: 0, block };
        }
      }
    }
    assertUsableCompletion(
      finishReason,
      text !== '' || thinking !== '' || toolBlocks.length > 0,
      this.id,
    );
    const content = assembleContent(text, thinking, toolBlocks);
    const response_: ModelResponse = {
      model: req.model,
      content,
      stopReason: normalizeStopReason(finishReason, toolBlocks.length > 0),
      usage: usage ?? this.estimateUsage(req, text + thinking),
      latencyMs: Date.now() - started,
    };
    if (ttftMs !== undefined) response_.ttftMs = ttftMs;
    if (salvaged > 0) response_.salvagedToolCalls = salvaged;
    response_.usage.costUSD = estimateCostUSD(response_.usage, caps.pricing);

    yield { type: 'message_end', response: response_ };
  }

  // -------------------------------------------------------------------------
  // Non-streaming
  // -------------------------------------------------------------------------

  private async completeNonStreaming(
    req: ModelRequest,
    caps: ModelCapabilities,
  ): Promise<ModelResponse> {
    const usePromptTools = !caps.nativeTools && (req.tools?.length ?? 0) > 0;
    const started = Date.now();
    const { response, dispose, timeoutSignal } = await this.requestCompletion(
      req,
      caps,
      false,
      usePromptTools,
    );
    let json: OpenAICompletion;
    try {
      json = (await abortable(response.json(), timeoutSignal)) as OpenAICompletion;
    } catch (err) {
      throw normalizeStreamError(err, req.signal, timeoutSignal, this.id, this.cfg.idleTimeoutMs);
    } finally {
      dispose();
    }

    if (json.error) throw mapErrorPayload(json.error, this.id, response.status);

    const choice = json.choices?.[0];
    const rawText = normalizeContentDelta(choice?.message?.content);
    const thinking =
      choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';

    let text = rawText;
    let toolBlocks: ToolUseBlock[] = [];

    if (usePromptTools) {
      const parser = new PromptToolParser();
      const a = parser.push(rawText);
      const b = parser.end();
      text = a.text + b.text;
      toolBlocks = [...a.calls, ...b.calls];
    } else {
      toolBlocks = (choice?.message?.tool_calls ?? []).map((tc, i) =>
        buildToolUseBlock(tc.id ?? `call_${i}`, tc.function?.name ?? '', tc.function?.arguments ?? ''),
      );
    }

    let salvaged = 0;
    const salvager = salvagerFor(req, caps, usePromptTools);
    if (salvager) {
      const shown = salvager.push(text);
      const out = salvager.end(toolBlocks.length > 0);
      if (out.calls.length > 0) {
        text = [shown.trimEnd(), out.text].filter((t) => t !== '').join('\n');
        toolBlocks = out.calls;
        salvaged = out.calls.length;
      } else if (
        toolBlocks.length === 0 &&
        (choice?.finish_reason === 'stop' || !choice?.finish_reason)
      ) {
        const bare = salvageBareToolCall(text, toolNameSet(req));
        if (bare) {
          text = bare.text;
          toolBlocks = bare.calls;
          salvaged = bare.calls.length;
        }
      }
    }

    assertUsableCompletion(
      choice?.finish_reason,
      text !== '' || thinking !== '' || toolBlocks.length > 0,
      this.id,
    );

    const usage = json.usage
      ? normalizeUsage(json.usage)
      : this.estimateUsage(req, text + thinking);
    usage.costUSD = estimateCostUSD(usage, caps.pricing);

    return {
      model: json.model ?? req.model,
      content: assembleContent(text, thinking, toolBlocks),
      stopReason: normalizeStopReason(choice?.finish_reason, toolBlocks.length > 0),
      usage,
      latencyMs: Date.now() - started,
      ...(salvaged > 0 ? { salvagedToolCalls: salvaged } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Request building
  // -------------------------------------------------------------------------

  /**
   * Issue the completion request, healing the one failure we can fix from here:
   * an endpoint that wants `reasoning_content` back on assistant turns that
   * never had any (a non-thinking run, or a session resumed from before we kept
   * it). The retry re-sends once with an empty field on those turns. Nothing has
   * been yielded to the caller at this point, so a streaming call can retry too.
   *
   * No endpoint demands this today (see `REASONING_REPLAY_REQUIRED`); it costs
   * one branch on an error path and turns a dead run into a retried one if any
   * ever does.
   */
  private async requestCompletion(
    req: ModelRequest,
    caps: ModelCapabilities,
    stream: boolean,
    usePromptTools: boolean,
  ): Promise<{
    response: Response;
    dispose: () => void;
    timeoutSignal: AbortSignal;
    touch: () => void;
  }> {
    try {
      return await this.request(
        '/chat/completions',
        this.buildBody(req, caps, stream, usePromptTools),
        req.signal,
      );
    } catch (err) {
      if (
        !(err instanceof ProviderError) ||
        err.kind !== 'bad_request' ||
        !REASONING_REPLAY_REQUIRED.test(err.message)
      ) {
        throw err;
      }
      return this.request(
        '/chat/completions',
        this.buildBody(req, caps, stream, usePromptTools, { emptyReasoningFallback: true }),
        req.signal,
      );
    }
  }

  private buildBody(
    req: ModelRequest,
    caps: ModelCapabilities,
    stream: boolean,
    usePromptTools: boolean,
    messageOpts: ToOpenAIMessagesOptions = {},
  ): Record<string, unknown> {
    const system = usePromptTools
      ? appendSystemSegment(req.system, {
          id: 'tool-protocol',
          text: renderToolPrompt(req.tools ?? []),
        })
      : req.system;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(system, req.messages, caps, {
        ...messageOpts,
        ...(caps.systemPromptUpdate === 'in-history' && req.systemUpdate?.length
          ? { systemUpdate: req.systemUpdate }
          : {}),
      }),
      stream,
    };

    if (req.maxOutputTokens !== undefined) {
      // Reasoning models on OpenAI renamed this parameter; everyone else kept
      // the old name, and several endpoints reject the new one outright.
      const key = caps.developerRole ? 'max_completion_tokens' : 'max_tokens';
      body[key] = Math.min(req.maxOutputTokens, caps.maxOutputTokens);
    }
    if (req.reasoningEffort !== undefined && caps.reasoning) {
      if (req.reasoningEffort === 'off') {
        // `off` is the absence of a level: say so with the endpoint's own
        // switch where there is one, and never send an effort alongside it.
        if (caps.thinkingParam) body['thinking'] = { type: 'disabled' };
      } else {
        if (caps.thinkingParam) body['thinking'] = { type: 'enabled' };
        body['reasoning_effort'] = mapEffort(req.reasoningEffort, caps.effortLevels);
      }
    }
    if (req.temperature !== undefined && !caps.fixedTemperature) {
      body['temperature'] = req.temperature;
    }
    if (req.topP !== undefined && !caps.fixedTemperature) body['top_p'] = req.topP;
    if (req.stopSequences?.length) body['stop'] = req.stopSequences;

    if (!usePromptTools && req.tools?.length) {
      body['tools'] = req.tools.map(toOpenAITool);
      if (req.toolChoice) body['tool_choice'] = toOpenAIToolChoice(req.toolChoice);
      // Only send this where it is understood: endpoints that do not know the
      // field reject the whole request rather than ignoring it.
      if (!caps.parallelToolCalls) body['parallel_tool_calls'] = false;
    }

    if (stream && caps.streamUsage) {
      body['stream_options'] = { include_usage: true };
    }

    return { ...body, ...(req.extraBody ?? {}) };
  }

  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{
    response: Response;
    dispose: () => void;
    timeoutSignal: AbortSignal;
    touch: () => void;
  }> {
    const url = `${this.cfg.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...(this.cfg.headers ?? {}),
    };
    if (this.cfg.apiKey) headers['authorization'] = `Bearer ${this.cfg.apiKey}`;

    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      // A controlled deadline — NOT `AbortSignal.timeout()`, whose timer would
      // outlive this attempt and, minutes later, fire an uncatchable
      // `TimeoutError` on a signal nobody is listening to (an unhandled
      // rejection that takes the process down). `dispose()` clears it the
      // moment we have a response or an error.
      const dl = deadline(this.cfg.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, dl.signal]) : dl.signal;

      let res: Response;
      try {
        res = await this.doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        dl.dispose();
        if (signal?.aborted) {
          throw new ProviderError('aborted', 'Request aborted', {
            provider: this.id,
            retryable: false,
            cause: err,
          });
        }
        // The deadline firing looks like an aborted fetch; classify it as a
        // retryable network timeout, not a hard abort.
        const timedOut = isTimeoutError(err) || dl.signal.aborted;
        lastError = new ProviderError(
          'network',
          timedOut
            ? `Request to ${this.id} timed out after ${this.cfg.timeoutMs}ms`
            : `Could not reach ${this.id} at ${this.cfg.baseUrl}: ${errText(err)}`,
          { provider: this.id, retryable: true, cause: err },
        );
        if (attempt < this.cfg.maxRetries) {
          await sleep(backoffMs(attempt), signal);
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        // Headers are in, so the header deadline has done its job. The body is
        // the caller's to consume under an *idle* deadline: a stream may take
        // far longer than any total timeout would allow, as long as it keeps
        // saying something.
        dl.dispose();
        const idle = deadline(this.cfg.idleTimeoutMs);
        return {
          response: res,
          dispose: idle.dispose,
          timeoutSignal: idle.signal,
          touch: idle.refresh,
        };
      }

      dl.dispose();
      const detail = await safeReadText(res);
      const error = mapHttpError(res.status, detail, this.id, retryAfterMs(res.headers));
      if (!error.retryable || attempt === this.cfg.maxRetries) throw error;
      lastError = error;
      await sleep(error.retryAfterMs ?? backoffMs(attempt), signal);
    }

    throw lastError ?? new ProviderError('unknown', 'Request failed', { provider: this.id });
  }

  private estimateUsage(req: ModelRequest, output: string): Usage {
    return {
      ...emptyUsage(),
      inputTokens: this.countTokens(flattenRequestText(req)),
      outputTokens: this.countTokens(output),
      estimated: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Streaming tool-call assembly
// ---------------------------------------------------------------------------

interface Slot {
  id: string;
  name: string;
  args: string;
  /** Whether `tool_use_start` has been emitted (needs a name to be useful). */
  started: boolean;
  ended: boolean;
}

/**
 * Reassembles `tool_calls` deltas.
 *
 * The failure modes this exists to absorb, all observed in the wild:
 *   - `index` present and stable (OpenAI) — the easy case.
 *   - `index` absent entirely; deltas belong to the most recently opened call.
 *   - `id` only on the first delta, or never sent at all.
 *   - `function.name` split across chunks, or repeated identically in every
 *     chunk (in which case appending would produce `readreadread`).
 *   - The whole call delivered complete in a single chunk.
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<number, Slot>();
  private nextIndex = 0;
  private lastIndex = -1;

  push(deltas: readonly OpenAIToolCallDelta[]): StreamEvent[] {
    const events: StreamEvent[] = [];

    for (const delta of deltas) {
      const index = this.resolveIndex(delta);
      let slot = this.slots.get(index);
      if (!slot) {
        slot = { id: delta.id ?? `call_${index}`, name: '', args: '', started: false, ended: false };
        this.slots.set(index, slot);
      } else if (delta.id && slot.id.startsWith('call_') && delta.id !== slot.id) {
        slot.id = delta.id;
      }
      this.lastIndex = index;

      const name = delta.function?.name;
      if (name) {
        // Repeated-in-every-chunk vs genuinely-split-across-chunks.
        if (slot.name === '') slot.name = name;
        else if (slot.name !== name && !slot.name.endsWith(name)) slot.name += name;
      }

      if (!slot.started && slot.name !== '') {
        slot.started = true;
        events.push({ type: 'tool_use_start', index, id: slot.id, name: slot.name });
      }

      const args = delta.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        slot.args += args;
        if (slot.started) events.push({ type: 'tool_use_delta', index, argsDelta: args });
      }
    }

    return events;
  }

  /** Close every open slot. Emitted in index order so results are deterministic. */
  finalize(): Array<{ index: number; block: ToolUseBlock }> {
    const out: Array<{ index: number; block: ToolUseBlock }> = [];
    for (const index of [...this.slots.keys()].sort((a, b) => a - b)) {
      const slot = this.slots.get(index);
      if (!slot || slot.ended) continue;
      slot.ended = true;
      out.push({ index, block: buildToolUseBlock(slot.id, slot.name, slot.args) });
    }
    return out;
  }

  private resolveIndex(delta: OpenAIToolCallDelta): number {
    if (typeof delta.index === 'number') {
      this.nextIndex = Math.max(this.nextIndex, delta.index + 1);
      return delta.index;
    }
    // No index. A delta carrying an id we have already seen continues that call;
    // a delta carrying a new id starts one; a bare fragment continues the last.
    if (delta.id) {
      for (const [i, slot] of this.slots) if (slot.id === delta.id) return i;
      return this.nextIndex++;
    }
    if (delta.function?.name && this.lastIndex !== -1) {
      const last = this.slots.get(this.lastIndex);
      // A fresh name on an already-named slot means a new call, not a rename.
      if (last && last.name !== '' && last.name !== delta.function.name) {
        return this.nextIndex++;
      }
    }
    return this.lastIndex === -1 ? this.nextIndex++ : this.lastIndex;
  }
}

/** A salvager for this request, when the model is prone to text-channel tool calls. */
function salvagerFor(
  req: ModelRequest,
  caps: ModelCapabilities,
  usePromptTools: boolean,
): DsmlSalvager | undefined {
  if (!caps.textToolCallSalvage || usePromptTools || (req.tools?.length ?? 0) === 0) return undefined;
  return new DsmlSalvager(toolNameSet(req));
}

function toolNameSet(req: ModelRequest): Set<string> {
  return new Set((req.tools ?? []).map((t) => t.name));
}

function buildToolUseBlock(id: string, name: string, args: string): ToolUseBlock {
  const raw = args.trim();
  const block: ToolUseBlock = { type: 'tool_use', id, name, input: {}, rawInput: raw };
  if (raw === '') return block;

  const parsed = parseLooseJSON(raw);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    block.input = parsed.value;
  } else {
    block.parseError = parsed.error ?? 'tool arguments were not a JSON object';
  }
  return block;
}

// ---------------------------------------------------------------------------
// Translation: internal shape -> OpenAI shape
// ---------------------------------------------------------------------------

export interface ToOpenAIMessagesOptions {
  /**
   * Revised system text to deliver without touching the head (see
   * `ModelRequest.systemUpdate`). Emitted as a `system` message just before the
   * conversation's last message — the shape probe 3 verified DeepSeek honours.
   */
  systemUpdate?: readonly SystemSegment[];
  /**
   * Put `reasoning_content: ""` on replayed assistant turns that carry no
   * thinking of their own (a non-thinking run, or a session resumed from before
   * reasoning was kept). Only used to recover from an endpoint that demands the
   * field on every assistant turn — see `REASONING_REPLAY_REQUIRED`.
   */
  emptyReasoningFallback?: boolean;
}

export function toOpenAIMessages(
  system: readonly SystemSegment[] | undefined,
  messages: readonly Message[],
  caps: ModelCapabilities,
  opts: ToOpenAIMessagesOptions = {},
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  const systemText = (system ?? []).map((s) => s.text).join('\n\n');
  if (systemText !== '') {
    out.push({ role: caps.developerRole ? 'developer' : 'system', content: systemText });
  }

  const updateText = (opts.systemUpdate ?? []).map((seg) => seg.text).join('\n\n');
  // Where the update goes: as late as possible (the endpoint reads the last
  // system message, and a late message is outside the span earlier turns
  // cached), but never between an assistant's tool_calls and the tool messages
  // answering them — that split is a 400. When the conversation ends on tool
  // results, the update goes after everything instead.
  const last = messages[messages.length - 1];
  const endsOnToolResults =
    last?.role === 'user' && last.content.some((b) => b.type === 'tool_result');
  const updateBefore =
    updateText === '' || endsOnToolResults || messages.length === 0 ? -1 : messages.length - 1;

  messages.forEach((msg, i) => {
    if (i === updateBefore) {
      out.push({ role: caps.developerRole ? 'developer' : 'system', content: updateText });
    }
    if (msg.role === 'user') {
      // Tool results must land immediately after the assistant turn that asked
      // for them, and before any new user text, or the endpoint 400s.
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: block.content === '' ? '(no output)' : block.content,
        });
      }
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      if (text !== '') out.push({ role: 'user', content: text });
      return;
    }

    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    const toolCalls = msg.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );

    // Reasoning replay is per-model. DeepSeek V4 *requires* every past
    // assistant turn's `reasoning_content` back once the request carries
    // `tools`, and 400s without it ("The reasoning_content in the thinking mode
    // must be passed back to the API"); everywhere else the field is unknown on
    // an input message, so it is dropped and kept only for display/telemetry.
    const replayReasoning = caps.reasoningReplay === 'text';
    const thinking = replayReasoning
      ? msg.content
          .filter((b) => b.type === 'thinking')
          .map((b) => (b as { text: string }).text)
          .join('')
      : '';

    // A turn that is only reasoning still has to be replayed when the endpoint
    // wants the reasoning back — dropping it loses part of the prefix.
    if (text === '' && toolCalls.length === 0 && thinking === '') return;

    const assistant: OpenAIMessage = {
      // Never `null`: DeepSeek (and several gateways) reject a null content on
      // an assistant turn, and dsh always sends `""`.
      role: 'assistant',
      content: text,
    };
    if (thinking !== '') assistant.reasoning_content = thinking;
    else if (replayReasoning && opts.emptyReasoningFallback) assistant.reasoning_content = '';
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.rawInput ?? JSON.stringify(tc.input ?? {}),
        },
      }));
    }
    out.push(assistant);
  });

  // Not placed inline (an empty history, or one ending on tool results): the
  // update still has to be said, so it goes last.
  if (updateText !== '' && updateBefore === -1) {
    out.push({ role: caps.developerRole ? 'developer' : 'system', content: updateText });
  }

  return out;
}

function toOpenAITool(tool: ToolDefinition): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAIToolChoice(choice: NonNullable<ModelRequest['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  if ('names' in choice) {
    return {
      type: 'allowed_tools',
      mode: choice.mode,
      tools: choice.names.map((name) => ({ type: 'function', function: { name } })),
    };
  }
  return { type: 'function', function: { name: choice.name } };
}

function appendSystemSegment(
  system: readonly SystemSegment[] | undefined,
  segment: SystemSegment,
): SystemSegment[] {
  return [...(system ?? []), segment];
}

function assembleContent(
  text: string,
  thinking: string,
  toolBlocks: readonly ToolUseBlock[],
): AssistantBlock[] {
  const content: AssistantBlock[] = [];
  if (thinking !== '') content.push({ type: 'thinking', text: thinking });
  if (text !== '') content.push({ type: 'text', text });
  content.push(...toolBlocks);
  return content;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Finish reasons that are failures wearing a completion's clothes. DeepSeek
 * returns `insufficient_system_resource` when it sheds load mid-generation
 * (api-docs.deepseek.com/quick_start/error_codes); treating it as `end_turn`
 * silently truncates the run, so it is raised as a retryable error instead.
 */
const ERROR_FINISH_REASONS: Record<string, string> = {
  insufficient_system_resource: 'the endpoint ran out of capacity mid-generation',
};

/**
 * Raises the provider error behind a failure-shaped completion, if any:
 * an error finish reason, or a completion that finished normally while saying
 * nothing at all (no text, no reasoning, no tool call). DeepSeek's own harness
 * retries both rather than surfacing an empty turn.
 */
function assertUsableCompletion(
  finishReason: string | undefined | null,
  hasContent: boolean,
  provider: string,
): void {
  const known = finishReason ? ERROR_FINISH_REASONS[finishReason] : undefined;
  if (known) {
    throw new ProviderError('server', `${provider}: ${known} (${finishReason})`, {
      provider,
      retryable: true,
    });
  }
  if (!hasContent && (finishReason === 'stop' || finishReason === 'eos')) {
    throw new ProviderError(
      'protocol',
      `${provider}: the model returned an empty completion`,
      { provider, retryable: true },
    );
  }
}

export function normalizeStopReason(
  finishReason: string | undefined | null,
  hasToolCalls: boolean,
): StopReason {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    case 'stop_sequence':
    case 'eos':
      // Several endpoints report `stop` even when they returned tool calls.
      // Trusting the field over the payload would strand the loop.
      return hasToolCalls ? 'tool_use' : 'end_turn';
    default:
      return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

export function normalizeUsage(raw: OpenAIUsage): Usage {
  const cached =
    raw.prompt_tokens_details?.cached_tokens ??
    raw.prompt_cache_hit_tokens ??
    raw.cache_read_input_tokens ??
    0;
  const usage: Usage = {
    inputTokens: raw.prompt_tokens ?? raw.input_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? raw.output_tokens ?? 0,
    cachedInputTokens: cached,
  };
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number' && reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

/**
 * `content` is a string on every well-behaved endpoint, but some return the
 * multimodal parts array even for plain text, and a few return `null`.
 */
function normalizeContentDelta(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const RETRYABLE_MESSAGE_PATTERNS: RegExp[] = [
  /overloaded/i,
  /rate[\s_-]?limit/i,
  /resource exhausted/i,
  /try again later/i,
  /temporarily unavailable/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /EAI_AGAIN/i,
];

/**
 * DeepSeek's documented 400 for a thinking-mode request with tools whose
 * history drops an assistant turn's `reasoning_content`. Probing the live
 * endpoint (2026-09-19) never produced it — we replay regardless, so this is
 * insurance against the documented behaviour reappearing, not a hot path.
 */
const REASONING_REPLAY_REQUIRED = /reasoning_content[\s\S]*passed back/i;

/** True when the error text looks like a transient failure across OpenAI-compat providers. */
export function messageSuggestsRetry(message: string): boolean {
  return RETRYABLE_MESSAGE_PATTERNS.some((re) => re.test(message));
}

function mapHttpError(
  status: number,
  detail: string,
  provider: string,
  retryAfterMsHint?: number,
): ProviderError {
  const parsed = parseLooseJSON(detail);
  const payload =
    parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
      ? ((parsed.value as { error?: unknown }).error ?? parsed.value)
      : undefined;
  const message = extractMessage(payload) ?? (detail.slice(0, 400) || `HTTP ${status}`);
  const retryAfter =
    retryAfterMsHint !== undefined ? { retryAfterMs: retryAfterMsHint } : {};

  if (status === 401 || status === 403) {
    return new ProviderError('auth', `${provider}: ${message}`, {
      status,
      provider,
      retryable: false,
      detail: redact(detail),
    });
  }
  if (status === 404) {
    return new ProviderError(
      'not_found',
      `${provider}: ${message} (check the model id and base URL)`,
      { status, provider, retryable: false, detail: redact(detail) },
    );
  }
  if (status === 402) {
    // DeepSeek's "insufficient balance". Retrying burns the rest of a run
    // against an account that cannot pay for it, so say so once and stop.
    return new ProviderError(
      'quota',
      `${provider}: ${message} (account balance exhausted — top up or switch models)`,
      { status, provider, retryable: false, detail: redact(detail) },
    );
  }
  if (status === 429) {
    return new ProviderError('rate_limit', `${provider}: ${message}`, {
      status,
      provider,
      detail: redact(detail),
      ...retryAfter,
    });
  }
  if (status === 400 || status === 413 || status === 422) {
    const kind = /context|too long|maximum.*token|token.*limit|reduce the length/i.test(
      message,
    )
      ? 'context_length'
      : 'bad_request';
    // Some gateways bury transient overload in a 400 body — upgrade when the text says so.
    const retryable = kind === 'bad_request' && messageSuggestsRetry(message);
    return new ProviderError(kind, `${provider}: ${message}`, {
      status,
      provider,
      retryable,
      detail: redact(detail),
      ...retryAfter,
    });
  }
  if (status >= 500) {
    return new ProviderError('server', `${provider}: ${message}`, {
      status,
      provider,
      detail: redact(detail),
      ...retryAfter,
    });
  }
  return new ProviderError('unknown', `${provider}: ${message}`, {
    status,
    provider,
    retryable: messageSuggestsRetry(message),
    detail: redact(detail),
    ...retryAfter,
  });
}

function mapErrorPayload(
  payload: unknown,
  provider: string,
  status: number | undefined,
): ProviderError {
  return mapHttpError(status ?? 500, JSON.stringify({ error: payload }), provider);
}

function extractMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  for (const key of ['message', 'msg', 'detail', 'error_msg']) {
    const v = obj[key];
    if (typeof v === 'string' && v !== '') return v;
    if (v && typeof v === 'object') {
      const nested = extractMessage(v);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Strip anything that looks like a credential before it reaches a log. */
function redact(text: string): string {
  return text
    .replace(/(sk-|xai-|gsk_)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/("?(api[_-]?key|authorization|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1***$4')
    .slice(0, 2_000);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

/**
 * A timeout signal whose timer is cleared by `dispose()`.
 *
 * Deliberately not `AbortSignal.timeout()`: that schedules a timer with no
 * handle to cancel it, so a request that finishes early leaves a timer that
 * fires minutes later and aborts a signal nobody listens to — Node reports the
 * resulting `TimeoutError` as an unhandled rejection and the process exits.
 */
interface Deadline {
  signal: AbortSignal;
  dispose: () => void;
  /** Restart the clock — the connection just proved it is alive. */
  refresh: () => void;
}

function deadline(ms: number): Deadline {
  const controller = new AbortController();
  let done = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    timer = setTimeout(() => {
      controller.abort(new DOMException(`Timed out after ${ms}ms`, 'TimeoutError'));
    }, ms);
    // Don't keep the event loop alive just for the deadline.
    (timer as { unref?: () => void }).unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    dispose: () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
    },
    refresh: () => {
      if (done) return;
      clearTimeout(timer);
      arm();
    },
  };
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'HeadersTimeoutError')
  );
}

/** Reject when `signal` aborts; otherwise settle with `p`. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Turn whatever escapes a streaming/body read into a `ProviderError` so a slow
 * or dropped response fails one turn (retryably) instead of crashing the run.
 */
function normalizeStreamError(
  err: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  id: string,
  timeoutMs: number,
): ProviderError {
  if (err instanceof ProviderError) return err;
  if (externalSignal?.aborted) {
    return new ProviderError('aborted', 'Request aborted', {
      provider: id,
      retryable: false,
      cause: err,
    });
  }
  if (isTimeoutError(err) || timeoutSignal.aborted) {
    return new ProviderError(
      'network',
      `Streaming response from ${id} timed out after ${timeoutMs}ms`,
      { provider: id, retryable: true, cause: err },
    );
  }
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError') {
    return new ProviderError('network', `Connection to ${id} dropped mid-stream`, {
      provider: id,
      retryable: true,
      cause: err,
    });
  }
  return new ProviderError('network', `Stream from ${id} failed: ${errText(err)}`, {
    provider: id,
    retryable: true,
    cause: err,
  });
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Moved to `../context/tokenizer.ts` so the loop can share it; re-exported here
// because that is where callers (and tests) have always imported it from.
export { heuristicTokenCount } from '../context/tokenizer.js';

// ---------------------------------------------------------------------------
// Wire shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIDelta {
  role?: string;
  content?: unknown;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_cache_hit_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIStreamChunk {
  model?: string;
  error?: unknown;
  usage?: OpenAIUsage;
  choices?: Array<{ index?: number; delta?: OpenAIDelta; finish_reason?: string | null }>;
}

interface OpenAICompletion {
  model?: string;
  error?: unknown;
  usage?: OpenAIUsage;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: unknown;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Replayed reasoning for endpoints that require it back (DeepSeek V4). */
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}
