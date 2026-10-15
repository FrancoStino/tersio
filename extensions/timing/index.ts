// pi records total duration but no first-token latency, so TTFT reads null there; omp writes its own `ttft` and OpenCode records `time.streamed`, so this fills the gap only for pi.
import type { ExtensionApi } from '../shared/types.ts';

interface AssistantMessage {
  role?: unknown;
  /** Unix ms when the request started, which pi sets before the stream opens. */
  timestamp?: unknown;
  ttft?: unknown;
}

interface MessageEvent {
  message?: AssistantMessage;
}

interface UpdateEvent extends MessageEvent {
  assistantMessageEvent?: { type?: unknown };
}

export default function timingExtension(pi: ExtensionApi): void {
  // First token per request, keyed by the request's own start stamp, which survives every stream event.
  const firstTokenAt = new Map<number, number>();

  pi.on<UpdateEvent>('message_update', (event: UpdateEvent) => {
    const message = event.message;
    if (!message || message.role !== 'assistant') return;
    const anchor = typeof message.timestamp === 'number' ? message.timestamp : 0;
    if (anchor <= 0 || firstTokenAt.has(anchor)) return;
    // `start` opens the stream with no token yet; the first delta is the first token.
    if (!String(event.assistantMessageEvent?.type ?? '').endsWith('_delta')) return;
    firstTokenAt.set(anchor, Date.now());
  });

  pi.on<MessageEvent>('message_end', (event: MessageEvent) => {
    const message = event.message;
    if (!message || message.role !== 'assistant') return;
    const anchor = typeof message.timestamp === 'number' ? message.timestamp : 0;
    const at = anchor > 0 ? firstTokenAt.get(anchor) : undefined;
    if (anchor > 0) firstTokenAt.delete(anchor);
    // A host that recorded its own latency wins; this only fills the gap.
    if (at === undefined || message.ttft !== undefined) return;
    const ttft = at - anchor;
    if (ttft > 0) message.ttft = ttft;
  });
}
