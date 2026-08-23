import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBrowserFrames } from "./capture/browser.js";
import { runCommand, type CommandRunner } from "./process-runner.js";

const CHROMIUM_VERSION = "151.0.7922.138";

export type WorkerPreflightReport = Readonly<{
  status: "PASS";
  chromiumVersion: string;
  renderer: string;
  fontReady: true;
  webgl2: true;
  networkPolicy: "external-blocked";
  repeatedFrameByteIdentity: true;
  ffmpeg: true;
  ffprobe: true;
  compilerModels: true;
  runtimeDigest: string;
}>;

type Dependencies = Readonly<{
  runCommand?: CommandRunner;
  captureFrames?: typeof captureBrowserFrames;
}>;

export async function runWorkerPreflight(
  signal: AbortSignal,
  dependencies: Dependencies = {},
): Promise<WorkerPreflightReport> {
  const command = dependencies.runCommand ?? runCommand;
  const capture = dependencies.captureFrames ?? captureBrowserFrames;
  const workspace = await mkdtemp(join(tmpdir(), "rvs-preflight-"));
  const options = { cwd: workspace, signal, timeoutMs: 120_000 };
  const chromePath = process.env.CHROME_PATH ?? "/opt/chrome/chrome";
  const fontPath =
    process.env.RVS_FONT_PATH ?? "/opt/rvs/fonts/WantedSansVariable.ttf";
  try {
    const chrome = await command(chromePath, ["--version"], options);
    if (!chrome.stdout.includes(CHROMIUM_VERSION))
      throw new Error("CHROMIUM_VERSION_MISMATCH");
    await command(
      process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
      ["-version"],
      options,
    );
    await command(
      process.env.RVS_FFPROBE_PATH ?? "ffprobe",
      ["-version"],
      options,
    );
    await command(
      process.env.RVS_PYTHON_PATH ?? "python3.12",
      ["-c", "from compiler.pipeline import verify_models; verify_models()"],
      options,
    );
    const browser = await capture({
      workspace,
      framesDirectory: join(workspace, "frames"),
      chromePath,
      fontPath,
      frames: [
        {
          frame: 0,
          markup: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        },
      ],
      residualRgb16x9: [Array<number>(432).fill(0)],
      signal,
      onFrame: async () => undefined,
      renderContract: { kind: "preflight" },
    });
    const facts = {
      status: "PASS" as const,
      chromiumVersion: browser.chromiumVersion,
      renderer: browser.renderer,
      fontReady: browser.fontReady,
      webgl2: browser.webgl2,
      networkPolicy: browser.networkPolicy,
      repeatedFrameByteIdentity: browser.repeatedFrameByteIdentity,
      ffmpeg: true as const,
      ffprobe: true as const,
      compilerModels: true as const,
    };
    return {
      ...facts,
      runtimeDigest: createHash("sha256")
        .update(JSON.stringify(facts))
        .digest("hex"),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
