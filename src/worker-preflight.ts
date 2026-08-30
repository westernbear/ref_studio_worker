import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBrowserFrames } from "./capture/browser.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import {
  assertRuntimeIdentity,
  REGISTERED_RUNTIME,
  runtimeSnapshotDigest,
  sha256,
  type RegisteredRuntimeSnapshot,
} from "./runtime-snapshot.js";

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
  runtimeSnapshotDigest: string;
  runtimeDigest: string;
}>;

type Dependencies = Readonly<{
  runCommand?: CommandRunner;
  captureFrames?: typeof captureBrowserFrames;
  readIdentityFile?: (path: string) => Promise<Uint8Array>;
  registeredRuntime?: RegisteredRuntimeSnapshot;
  declaredImageDigest?: string;
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
  const registered = dependencies.registeredRuntime ?? REGISTERED_RUNTIME;
  const workspace = await mkdtemp(join(tmpdir(), "rvs-preflight-"));
  const options = {
    cwd: workspace,
    signal,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  };
  const chromePath = process.env.CHROME_PATH ?? registered.chrome.path;
  const fontPath = process.env.RVS_FONT_PATH ?? registered.font.path;
  const modelManifestPath =
    process.env.RVS_MODEL_MANIFEST_PATH ?? "/app/compiler/model-manifest.json";
  try {
    const chrome = await command(chromePath, ["--version"], options);
    const ffmpeg = await command(
      process.env.RVS_FFMPEG_PATH ?? registered.ffmpeg.path,
      ["-version"],
      options,
    );
    const ffprobe = await command(
      process.env.RVS_FFPROBE_PATH ?? registered.ffprobe.path,
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
    const [
      modelManifest,
      chromeBytes,
      font,
      ffmpegBytes,
      ffprobeBytes,
      nodeBytes,
    ] = await Promise.all([
      readIdentityFile(modelManifestPath),
      readIdentityFile(chromePath),
      readIdentityFile(fontPath),
      readIdentityFile(process.env.RVS_FFMPEG_PATH ?? registered.ffmpeg.path),
      readIdentityFile(process.env.RVS_FFPROBE_PATH ?? registered.ffprobe.path),
      readIdentityFile(process.execPath),
    ]);
    const identity = {
      chromeVersion: chrome.stdout.trim().split(/\s+/u).at(-1) ?? "",
      chromeSha256: sha256(chromeBytes),
      fontSha256: sha256(font),
      ffmpegVersion: ffmpeg.stdout.match(/^ffmpeg version (\S+)/u)?.[1] ?? "",
      ffmpegSha256: sha256(ffmpegBytes),
      ffprobeVersion:
        ffprobe.stdout.match(/^ffprobe version (\S+)/u)?.[1] ?? "",
      ffprobeSha256: sha256(ffprobeBytes),
      nodeVersion: process.version.replace(/^v/u, ""),
      nodeSha256: sha256(nodeBytes),
      imageDigest:
        dependencies.declaredImageDigest ??
        process.env.RVS_WORKER_IMAGE_DIGEST ??
        "",
    };
    assertRuntimeIdentity(identity, registered);
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
    assertRuntimeIdentity(
      { ...identity, renderer: browser.renderer },
      registered,
    );
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
    const runtimeIdentity = {
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
      imageDigest: identity.imageDigest,
    };
    return {
      ...facts,
      runtimeSnapshotDigest: runtimeSnapshotDigest(registered),
      runtimeDigest: createHash("sha256")
        .update(
          JSON.stringify({ facts, identity: runtimeIdentity, registered }),
        )
        .digest("hex"),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
