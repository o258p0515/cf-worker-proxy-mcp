import { describe, it, expect, vi } from "vitest";
import { SseSessionDO } from "../src/mcp/sse-session-do";

function makeState() {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key)
    } as any
  };
}

describe("Durable Object account selection storage", () => {
  it("persists the selected account across Durable Object instances", async () => {
    const state = makeState();
    const first = new SseSessionDO(state as any, {} as any);
    const saved = await first.fetch(new Request("https://session.internal/_internal/account-selection", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alias: "personal" })
    }));
    expect(saved.status).toBe(200);

    const second = new SseSessionDO(state as any, {} as any);
    const response = await second.fetch(new Request("https://session.internal/_internal/account-selection"));
    expect((await response.json() as any).alias).toBe("personal");
  });

  it("rejects empty aliases", async () => {
    const session = new SseSessionDO(makeState() as any, {} as any);
    const response = await session.fetch(new Request("https://session.internal/_internal/account-selection", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alias: " " })
    }));
    expect(response.status).toBe(400);
  });
});


describe("SSE idle lifecycle", () => {
  it("closes an idle stream and clears its keepalive timer after 20 minutes", async () => {
    vi.useFakeTimers();
    try {
      const session = new SseSessionDO(makeState() as any, {} as any);
      const response = await session.fetch(new Request("https://session.internal/sse"));
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("event: endpoint");
      for (let i = 0; i < 48; i++) {
        await vi.advanceTimersByTimeAsync(25_000);
        if (i < 47) {
          const keepalive = await reader.read();
          expect(new TextDecoder().decode(keepalive.value)).toContain(": keepalive");
        }
      }
      const ended = await reader.read();
      expect(ended.done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
