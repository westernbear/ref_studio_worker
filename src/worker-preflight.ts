import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBrowserFrames } from "./capture/browser.js";
import { runCommand, type CommandRunner } from "./process-runner.js";

const CHROMIUM_VERSION = "151.0.7922.138";
const PREFLIGHT_TIMEOUT_MS = 120_000;

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
  tar: true;
  compilerModels: true;
  runtimeDigest: string;
}>;

type Dependencies = Readonly<{
  runCommand?: CommandRunner;
  captureFrames?: typeof captureBrowserFrames;
  readIdentityFile?: (path: string) => Promise<Uint8Array>;
}>;

export async function runWorkerPreflight(
  signal: AbortSignal,
  dependencies: Dependencies = {},
): Promise<WorkerPreflightReport> {
  const command = dependencies.runCommand ?? runCommand;
  const capture = dependencies.captureFrames ?? captureBrowserFrames;
  const readIdentityFile =
    dependencies.readIdentityFile ??
    ((path: string): Promise<Uint8Array> => readFile(path));
  const workspace = await mkdtemp(join(tmpdir(), "rvs-preflight-"));
  const options = {
    cwd: workspace,
    signal,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  };
  const chromePath = process.env.CHROME_PATH ?? "/opt/chrome/chrome";
  const fontPath =
    process.env.RVS_FONT_PATH ?? "/opt/rvs/fonts/WantedSansVariable.ttf";
  const modelManifestPath =
    process.env.RVS_MODEL_MANIFEST_PATH ?? "/app/compiler/model-manifest.json";
  try {
    const chrome = await command(chromePath, ["--version"], options);
    if (!chrome.stdout.includes(CHROMIUM_VERSION))
      throw new Error("CHROMIUM_VERSION_MISMATCH");
    const ffmpeg = await command(
      process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
      ["-version"],
      options,
    );
    const ffprobe = await command(
      process.env.RVS_FFPROBE_PATH ?? "ffprobe",
      ["-version"],
      options,
    );
    const tar = await command(
      process.env.RVS_TAR_PATH ?? "tar",
      ["--version"],
      options,
    );
    await command(
      process.env.RVS_PYTHON_PATH ?? "python3.12",
      ["-c", "from compiler.pipeline import verify_models; verify_models()"],
      options,
    );
    const [modelManifest, font] = await Promise.all([
      readIdentityFile(modelManifestPath),
      readIdentityFile(fontPath),
    ]);
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
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      ]),
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
      tar: true as const,
      compilerModels: true as const,
    };
    const identity = {
      nodeVersion: process.version,
      modelManifestSha256: createHash("sha256")
        .update(modelManifest)
        .digest("hex"),
      fontSha256: createHash("sha256").update(font).digest("hex"),
      ffmpegVersion: ffmpeg.stdout.trim(),
      ffprobeVersion: ffprobe.stdout.trim(),
      tarVersion: tar.stdout.trim(),
      rendererIdentity: createHash("sha256")
        .update(JSON.stringify(browser))
        .digest("hex"),
      imageDigest: process.env.RVS_WORKER_IMAGE_DIGEST ?? null,
    };
    return {
      ...facts,
      runtimeDigest: createHash("sha256")
        .update(JSON.stringify({ facts, identity }))
        .digest("hex"),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
