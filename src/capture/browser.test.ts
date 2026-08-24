import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBrowserFrames, CdpClient } from "./browser.js";

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

  it("rejects when Chromium cannot be spawned", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-browser-test-"));
    try {
      await expect(
        captureBrowserFrames({
          workspace,
          framesDirectory: join(workspace, "frames"),
          chromePath: join(workspace, "missing-chromium"),
          fontPath: join(workspace, "font.ttf"),
          frames: [
            {
              frame: 0,
              markup: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            },
          ],
          residualRgb16x9: [Array<number>(432).fill(0)],
          signal: new AbortController().signal,
          onFrame: async () => undefined,
          renderContract: { kind: "preflight" },
        }),
      ).rejects.toThrow("CHROMIUM_START_FAILED");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
