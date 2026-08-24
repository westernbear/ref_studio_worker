import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClient } from "./browser.js";

class FakeWebSocket extends EventTarget {
  constructor(_url: string) {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(_data: string): void {}

  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("CDP cancellation", () => {
  it("rejects an active command when its signal aborts", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const controller = new AbortController();
    const client = await CdpClient.connect(
      "ws://127.0.0.1/devtools/page/test",
      controller.signal,
    );
    const pending = client.send<unknown>("Runtime.evaluate");

    controller.abort();

    await expect(
      Promise.race([
        pending,
        delay(25).then(() => {
          throw new Error("CDP_ABORT_NOT_OBSERVED");
        }),
      ]),
    ).rejects.toThrow("WORKER_JOB_CANCELLED");
  });
});
