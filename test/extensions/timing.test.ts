// pi records no first-token latency, so the timer stamps one into the message the host persists.
import { expect, test } from "vitest";

import timingExtension from "../../extensions/timing/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakeHost(): { handlers: Map<string, Handler[]>; fire: (name: string, event: unknown) => Promise<void> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    hostId: "pi",
    on(event: string, handler: Handler) {
      (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler);
    },
  };
  timingExtension(pi as never);
  return {
    handlers,
    async fire(name, event) {
      for (const handler of handlers.get(name) ?? []) await handler(event, {});
    },
  };
}

const assistant = (timestamp: number): { role: string; timestamp: number; ttft?: number } => ({ role: "assistant", timestamp });

test("the first token gap is stamped onto the message", async () => {
  const { fire } = fakeHost();
  const started = 1_700_000_000_000;
  const message = assistant(started);
  await fire("message_start", { message });
  // `start` opens the stream with no token yet, so it must not count as the first one.
  await fire("message_update", { message, assistantMessageEvent: { type: "start" } });
  expect(message.ttft, "a bare start is not a token").toBeUndefined();
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "h" } });
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "i" } });
  await fire("message_end", { message });
  expect(message.ttft, "the first delta sets the latency").toBeGreaterThan(0);
});

test("a host that recorded its own latency keeps it", async () => {
  const { fire } = fakeHost();
  const message = { ...assistant(1_700_000_000_000), ttft: 42 };
  await fire("message_start", { message });
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  await fire("message_end", { message });
  expect(message.ttft, "the host's own value wins").toBe(42);
});

test("a message with no first token records nothing", async () => {
  const { fire } = fakeHost();
  const message = assistant(1_700_000_000_000);
  await fire("message_start", { message });
  await fire("message_end", { message });
  expect(message.ttft, "no token means no latency, never zero").toBeUndefined();
});

test("non-assistant messages are left alone", async () => {
  const { fire } = fakeHost();
  const message: { role: string; timestamp: number; ttft?: number } = { role: "toolResult", timestamp: 1_700_000_000_000 };
  await fire("message_start", { message });
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  await fire("message_end", { message });
  expect(message.ttft).toBeUndefined();
});
