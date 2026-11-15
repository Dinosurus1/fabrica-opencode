import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionEvents } from "./events";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("useSessionEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("abre el stream y pasa a live", () => {
    const { result } = renderHook(() => useSessionEvents(() => {}));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => {
      FakeEventSource.instances[0]!.onopen?.(new Event("open"));
    });
    expect(result.current.status).toBe("live");
  });

  it("reconecta tras un cierre y limpia el stream al desmontar", () => {
    const { unmount } = renderHook(() => useSessionEvents(() => {}));
    const first = FakeEventSource.instances[0]!;
    act(() => {
      first.onopen?.(new Event("open"));
      first.readyState = FakeEventSource.CLOSED;
      first.onerror?.(new Event("error"));
    });
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const last = FakeEventSource.instances.at(-1)!;
    unmount();
    expect(last.closed).toBe(true);
  });

  it("reenvía eventos JSON y descarta los ilegibles", () => {
    const received: string[] = [];
    renderHook(() => useSessionEvents((event) => received.push(event.type)));
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.onmessage?.({ data: JSON.stringify({ type: "session.updated" }) } as MessageEvent);
      source.onmessage?.({ data: "{roto" } as MessageEvent);
    });
    expect(received).toEqual(["session.updated"]);
  });
});
