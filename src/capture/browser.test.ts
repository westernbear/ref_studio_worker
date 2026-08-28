import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANVAS } from "../contracts/index.js";
import { captureBrowserFrames, CdpClient, renderPage } from "./browser.js";

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

describe("renderPage canvas sizing", () => {
  const aspects = Object.entries(CANVAS);

  for (const [aspect, dimensions] of aspects) {
    it(`sizes every dimension-bearing spot in the page to ${aspect}'s ${dimensions.width}x${dimensions.height}, with nothing left over from another ratio`, () => {
      const page = renderPage("/tmp/font.ttf", [], dimensions);

      // Every spot the defect report named must reflect this scene's own
      // canvas, not the portrait default.
      expect(page).toContain(
        `html, body { width: ${dimensions.width}px; height: ${dimensions.height}px;`,
      );
      expect(page).toContain(
        `width: ${dimensions.width}px; height: ${dimensions.height}px; }\n    #background-effects`,
      );
      expect(page).toContain(
        `#scene svg { width: ${dimensions.width}px; height: ${dimensions.height}px;`,
      );
      expect(page).toContain(
        `<canvas id="background-effects" width="${dimensions.width}" height="${dimensions.height}"></canvas>`,
      );
      expect(page).toContain(
        `<canvas id="owner-effects" width="${dimensions.width}" height="${dimensions.height}"></canvas>`,
      );
      expect(page).toContain(
        `gl.viewport(0, 0, ${dimensions.width}, ${dimensions.height});`,
      );
      expect(page).toContain(
        `svg.setAttribute("viewBox", "0 0 ${dimensions.width} ${dimensions.height}");`,
      );
      expect(page).toContain(`svg.setAttribute("width", "${dimensions.width}");`);
      expect(page).toContain(`svg.setAttribute("height", "${dimensions.height}");`);

      // No dimension pair belonging to one of the *other* two aspects
      // should survive anywhere in the page -- this is exactly the shape
      // of the shipped defect (a 1080x1920 page regardless of scene).
      for (const [otherAspect, other] of aspects) {
        if (otherAspect === aspect) continue;
        if (other.width === dimensions.width && other.height === dimensions.height)
          continue;
        expect(page).not.toContain(`width: ${other.width}px; height: ${other.height}px`);
        expect(page).not.toContain(
          `width="${other.width}" height="${other.height}"`,
        );
        expect(page).not.toContain(`gl.viewport(0, 0, ${other.width}, ${other.height})`);
        expect(page).not.toContain(`0 0 ${other.width} ${other.height}`);
      }
    });
  }
});

describe("renderPage text weight", () => {
  it("makes font-weight a default an element's own attribute can override, not a constant", () => {
    const page = renderPage("/tmp/font.ttf", [], CANVAS["9:16"]);

    // The base #scene text rule must no longer hardcode a weight -- that is
    // what made every piece of text in every generated film the same
    // weight despite Wanted Sans being a full variable-weight font.
    expect(page).not.toMatch(/#scene text \{[^}]*font-weight/);
    // A default-only rule, guarded the same way the existing fill default
    // is (:where(:not([...]))), so an element carrying its own
    // font-weight attribute wins over it.
    expect(page).toContain(
      "#scene text:where(:not([font-weight])) { font-weight: 700; }",
    );
  });
});
