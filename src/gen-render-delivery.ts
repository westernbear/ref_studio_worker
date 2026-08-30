import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CANVAS,
  DELIVERY_FPS,
  validateSceneSpec,
  type SceneSpec,
} from "./contracts/index.js";
import {
  captureBrowserFrames,
  type BrowserCaptureInput,
  type BrowserCaptureReport,
} from "./capture/browser.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import type { RenderDeliveryDependencies } from "./render-delivery.js";
import { createGeneratedRenderApp } from "./render-app/generated.js";
import { compileSceneSpec } from "./scene/spec-compile.js";
import { buildNativeScenePackage } from "./native-scene-package.js";
import { archiveScenePackage } from "./scene-package-archive.js";
import { assembleGeneratedVideo } from "./generated-video-delivery.js";
import { decodeVideoAsset, type VideoDecodeReport } from "./video-decoder.js";
import { validateAudioAsset, type ValidatedAudio } from "./audio-decoder.js";

export type GeneratedRenderReport = Readonly<{
  schema: "rvs.gen-render-report.v1";
  specDigest: string;
  outputSha256: string;
  outputBytes: number;
  frameSha256: readonly string[];
  // What the browser that drew these frames actually reported about itself.
  // The API binds `renderer` against the worker's registered preflight and
  // requires networkPolicy "external-blocked" -- material generation happens
  // in the `assets` phase, and by the time frames are drawn the browser is
  // sealed off exactly as it is for a restore render.
  runtime: Readonly<{
    chromiumVersion: string;
    renderer: string;
    fontReady: boolean;
    webgl2: boolean;
    networkPolicy: string;
    repeatedFrameByteIdentity: boolean;
    runtimeSnapshotDigest: string;
  }>;
  qc: Readonly<Record<string, unknown>>;
  videoDecode: readonly VideoDecodeReport[];
  // A local worker-filesystem path, for the content-safety sample upload --
  // never sent to the API, which keeps its report schema strict.
  safetySampleFramePath: string;
  scenePackageArchivePath?: string;
}>;

// CANVAS_MISMATCH is a render-time token (ruling 5), not one of
// validateSceneSpec's spec tokens: it asks whether this canvas is one a real
// job could have declared (one of the generation aspects, at delivery fps),
// not whether the spec is internally well-formed.
const isDeclaredCanvas = (canvas: SceneSpec["canvas"]): boolean =>
  canvas.fps === DELIVERY_FPS &&
  Object.values(CANVAS).some(
    (dimensions) =>
      dimensions.width === canvas.width && dimensions.height === canvas.height,
  );

export async function renderGeneratedDelivery(
  input: Readonly<{
    readonly spec: SceneSpec;
    readonly assetPaths: ReadonlyMap<string, string>;
    readonly assetDigests?: ReadonlyMap<string, string>;
    readonly assetContentTypes?: ReadonlyMap<string, string>;
    readonly outPath: string;
    readonly signal: AbortSignal;
    readonly scenePackagePath?: string;
  }>,
  dependencies: RenderDeliveryDependencies = {},
): Promise<GeneratedRenderReport> {
  if (!isDeclaredCanvas(input.spec.canvas)) throw new Error("CANVAS_MISMATCH");

  // Fail-closed gate (C2.3): a SceneSpec can reach this function by any
  // path, not only the one authorScene() already validates after its own
  // canvas override -- so this is checked again here, right before the
  // spec is trusted to compile into frames. Resolvable asset ids are the
  // ones this caller actually knows how to turn into bytes: whatever
  // assetPaths already resolved to a real file, plus any asset the model
  // declared as "generated" (gated separately by validateSceneSpec's own
  // provenance check, not by path resolution), plus every colour asset --
  // a colour's ref is its own value, so it has no file and the `assets`
  // phase deliberately never stores one for it (see planSceneAssets).
  const resolvableAssetIds = new Set<string>(input.assetPaths.keys());
  for (const asset of input.spec.assets)
    if (asset.origin === "generated" || asset.kind === "color")
      resolvableAssetIds.add(asset.assetId);
  // requireGeneratedOutput: this is render time, so every generated
  // material asset must already carry the tool and output hash the assets
  // stage recorded from what was really produced. Inline colours have no
  // bytes or provider output to account for (see planSceneAssets).
  validateSceneSpec(input.spec, resolvableAssetIds, {
    requireGeneratedOutput: true,
  });

  const command = dependencies.runCommand ?? runCommand;
  const capture = dependencies.captureFrames ?? captureBrowserFrames;
  const compilation = compileSceneSpec(input.spec);
  const canvas = input.spec.canvas;

  const fontPath =
    dependencies.fontPath ??
    process.env.RVS_FONT_PATH ??
    "/opt/rvs/fonts/WantedSansVariable.ttf";
  const fontAssets = input.spec.assets
    .filter((asset) => asset.kind === "font")
    .flatMap((asset) => {
      const path = input.assetPaths.get(asset.assetId);
      return path ? [{ family: asset.assetId, path }] : [];
    });
  const videoFramePaths = new Map<string, readonly string[]>();
  const videoDecode: VideoDecodeReport[] = [];
  for (const asset of input.spec.assets.filter(
    (candidate) => candidate.kind === "video",
  )) {
    const path = input.assetPaths.get(asset.assetId);
    const expectedSha256 =
      input.assetDigests?.get(asset.assetId) ?? asset.provenance?.sha256;
    const contentType = input.assetContentTypes?.get(asset.assetId);
    if (
      path === undefined ||
      expectedSha256 === undefined ||
      contentType === undefined
    )
      throw new Error("VIDEO_DECODE_UNSUPPORTED");
    const decoded = await decodeVideoAsset(
      {
        assetId: asset.assetId,
        bytes: await readFile(path),
        expectedSha256,
        contentType,
        canvas,
        workspace: dirname(input.outPath),
        signal: input.signal,
      },
      command,
    );
    videoFramePaths.set(asset.assetId, decoded.framePaths);
    videoDecode.push(decoded.report);
  }
  const audioAssets = input.spec.assets.filter(
    (candidate) => candidate.kind === "audio",
  );
  if (audioAssets.length > 1) throw new Error("MEDIA_QC_FAILED");
  let audio: ValidatedAudio | undefined;
  const audioAsset = audioAssets[0];
  if (audioAsset) {
    const path = input.assetPaths.get(audioAsset.assetId);
    const expectedSha256 =
      input.assetDigests?.get(audioAsset.assetId) ??
      audioAsset.provenance?.sha256;
    const contentType = input.assetContentTypes?.get(audioAsset.assetId);
    if (!path || !expectedSha256 || !contentType)
      throw new Error("MEDIA_QC_FAILED");
    audio = await validateAudioAsset(
      {
        asset: audioAsset,
        path,
        expectedSha256,
        contentType,
        canvas,
        workspace: dirname(input.outPath),
        signal: input.signal,
      },
      command,
    );
  }
  const app = createGeneratedRenderApp(
    compilation,
    [{ family: "Wanted Sans", path: fontPath }, ...fontAssets],
    input.spec.assets,
    input.assetPaths,
    videoFramePaths,
  );
  const renderedFrames = compilation.frames.map((plan) =>
    app.renderFrame(plan.frame),
  );

  const workspace = dirname(input.outPath);
  const framesDirectory = join(workspace, "gen-frames");
  await mkdir(framesDirectory, { recursive: true });
  const signal = input.signal;

  const captureInput: BrowserCaptureInput = {
    workspace,
    framesDirectory,
    chromePath:
      dependencies.chromePath ??
      process.env.CHROME_PATH ??
      "/opt/chrome/chrome",
    fontPath,
    frames: renderedFrames,
    signal,
    onFrame: async () => undefined,
    renderContract: {
      kind: "generated",
      canvas: { width: canvas.width, height: canvas.height },
    },
  };
  const captureReport: BrowserCaptureReport = await capture(captureInput);

  const qc = await assembleGeneratedVideo(
    {
      canvas,
      framesDirectory,
      outputPath: input.outPath,
      workspace,
      signal,
      ...(audio ? { audio } : {}),
    },
    command,
  );
  const qcWithVideoDecode = {
    ...qc,
    videoDecode,
    runtimeSnapshotDigest: captureReport.runtimeSnapshotDigest,
  };

  const scenePackage = input.scenePackagePath
    ? await buildNativeScenePackage({
        directory: input.scenePackagePath,
        scene: input.spec,
        assetPaths: input.assetPaths,
        fontPath,
        frames: renderedFrames,
        capability: {
          text: true,
          image: true,
          shape: true,
          video: true,
          rotation: true,
          anchor: true,
          "per-axis-scale": true,
          "parent-transform": true,
          easing: true,
        },
        verification: {
          status: "PASS",
          frameSha256: captureReport.frameSha256,
          repeatedFrameByteIdentity: captureReport.repeatedFrameByteIdentity,
          qc: qcWithVideoDecode,
        },
      })
    : undefined;
  const scenePackageArchivePath = scenePackage
    ? `${scenePackage.directory}.tar`
    : undefined;
  if (scenePackage && scenePackageArchivePath)
    await archiveScenePackage(
      scenePackage.directory,
      scenePackageArchivePath,
      signal,
      command,
    );

  const outputHash = createHash("sha256");
  let outputBytes = 0;
  for await (const chunk of createReadStream(input.outPath)) {
    outputHash.update(chunk);
    outputBytes += (chunk as Buffer).byteLength;
  }

  return {
    schema: "rvs.gen-render-report.v1",
    specDigest: compilation.digest,
    outputSha256: outputHash.digest("hex"),
    outputBytes,
    frameSha256: captureReport.frameSha256,
    runtime: {
      chromiumVersion: captureReport.chromiumVersion,
      renderer: captureReport.renderer,
      fontReady: captureReport.fontReady,
      webgl2: captureReport.webgl2,
      networkPolicy: captureReport.networkPolicy,
      repeatedFrameByteIdentity: captureReport.repeatedFrameByteIdentity,
      runtimeSnapshotDigest: captureReport.runtimeSnapshotDigest,
    },
    qc: qcWithVideoDecode,
    videoDecode,
    // The middle frame, same choice the restore delivery makes -- the most
    // representative single frame of the film.
    safetySampleFramePath: join(
      framesDirectory,
      `frame-${String(Math.floor(canvas.frameCount / 2)).padStart(6, "0")}.png`,
    ),
    ...(scenePackageArchivePath ? { scenePackageArchivePath } : {}),
  };
}

export type { CommandRunner };
