import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  captureBrowserFrames,
  type BrowserCaptureInput,
  type BrowserCaptureReport,
} from "./capture/browser.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import { createRenderApp } from "./render-app/index.js";
import {
  compileScene,
  type Compilation,
  type EvidenceInput,
  type Json,
} from "./scene/compile.js";

const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const ResidualRgb16x9 = z.array(z.number().min(0).max(1)).length(16 * 9 * 3);
const JsonValue: z.ZodType<Json> = z.json();
const FrameBounds = z
  .object({
    frame: z.number().int().nonnegative(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();
const Owner = z
  .object({
    ownerId: z.string().min(1),
    kind: z.string().min(1),
    editable: z.boolean(),
    assetRef: z.string().min(1),
    confidence: z.number().min(0).max(1),
    content: z.string().optional(),
  })
  .strict();
const Asset = z
  .object({
    assetId: z.string().min(1),
    kind: z.string().min(1),
    editable: z.boolean(),
    owner: z.string().min(1),
  })
  .catchall(JsonValue);
const Track = z
  .object({
    trackId: z.string().min(1),
    owner: z.string().min(1),
    lifecycle: z
      .object({
        enter: JsonValue.optional(),
        stable: JsonValue.optional(),
        exit: JsonValue.optional(),
      })
      .strict(),
    geometryRef: z.string().min(1),
    effects: z.array(z.string().min(1)),
  })
  .strict();
const Pass = z
  .object({
    passId: z.string().min(1),
    owner: z.string().min(1),
    kind: z.enum(["DOM/SVG", "WebGL2"]),
    shader: z.string().min(1).nullable(),
    reads: z.array(z.string()),
    writes: z.string().min(1),
  })
  .strict();
const EvidenceInputSchema = z
  .object({
    tenantId: z.string().min(1),
    editor: z.string().min(1),
    reason: z.string().min(1),
    timestamp: z.string().min(1),
    needsChoice: z.array(JsonValue).optional(),
    // Legacy field from before the approval-gate removal. No longer read by
    // compileScene, but pre-existing persisted evidence blobs may still
    // carry it; accept and ignore it so old in-flight jobs keep validating.
    gate: z.enum(["APPROVED", "PENDING", "REJECTED"]).optional(),
    owners: z.array(Owner),
    editableAssets: z.array(Asset),
    geometry: z.record(
      z.string(),
      z
        .object({
          boundsPerFrame: z.array(FrameBounds).min(1),
          fixedWidth: z.boolean(),
          fixedX: z.boolean(),
        })
        .strict(),
    ),
    tracks: z.array(Track),
    effects: z.record(
      z.string(),
      z.record(z.string(), z.record(z.string(), JsonValue)),
    ),
    residualCanvas: z
      .object({
        owner: z.string().min(1),
        measurements: z.array(z.string()),
        mustRemainSeparate: z.boolean(),
        compositeRule: z.string().min(1),
      })
      .strict(),
    audio: z
      .object({
        sampleRateHz: z.number().int().positive(),
        channels: z.number().int().positive(),
        frameRate: z.number().positive().optional(),
        anchors: z.array(
          z
            .object({
              anchorId: z.string().min(1),
              frame: z.number().int().nonnegative(),
              sample: z.number().int().nonnegative(),
              owner: z.string().min(1),
              role: z.string().min(1),
              confidence: z.number().min(0).max(1),
            })
            .strict(),
        ),
      })
      .strict(),
    passes: z.array(Pass),
    layerOrder: z.array(z.string().min(1)),
    allowedShaders: z.array(z.string().min(1)),
  })
  .strict();
const SceneEvidence = z.object({
  observed: z.object({
    palette: z.tuple([HexColor, HexColor]).rest(HexColor),
    effects: z.array(
      z.object({
        lowerLightRgb16x9: ResidualRgb16x9,
      }),
    ),
  }),
  sceneInput: EvidenceInputSchema,
});
export const CompilationSchema = z
  .object({
    authoring: z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/u) })
      .passthrough(),
    scene: z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/u) })
      .passthrough(),
    browserPassSpec: z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/u) })
      .passthrough(),
  })
  .strict();
const Probe = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(
    z.discriminatedUnion("codec_type", [
      z.object({
        codec_type: z.literal("video"),
        codec_name: z.string(),
        profile: z.string(),
        level: z.number().int(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        pix_fmt: z.string(),
        avg_frame_rate: z.string(),
        nb_read_frames: z.string(),
        color_space: z.string(),
        color_transfer: z.string(),
        color_primaries: z.string(),
      }),
      z.object({
        codec_type: z.literal("audio"),
        codec_name: z.string(),
        profile: z.string(),
        channels: z.number().int().positive(),
        sample_rate: z.string(),
      }),
    ]),
  ),
  frames: z.array(
    z.object({
      media_type: z.enum(["video", "audio"]),
      key_frame: z.number().int().min(0).max(1),
    }),
  ),
});

export const DELIVERY_FPS = 30;
export const DELIVERY_FRAME_COUNT = 120;
const DELIVERY_GOP = 60;
const DELIVERY_AUDIO_BIT_RATE = 192_000;

export type RenderDeliveryInput = Readonly<{
  mode: "preview" | "delivery";
  tenantId: string;
  jobId: string;
  attemptId: string;
  workspace: string;
  normalizedPath: string;
  outputPath: string;
  evidence: Record<string, unknown>;
  expectedCompilation: unknown;
  frameCount: number;
  sourceFps: number;
  signal: AbortSignal;
  onProgress: (framesProcessed: number, framesTotal: number) => Promise<void>;
}>;

export type RenderDeliveryDependencies = Readonly<{
  runCommand?: CommandRunner;
  captureFrames?: (input: BrowserCaptureInput) => Promise<BrowserCaptureReport>;
  chromePath?: string;
  fontPath?: string;
}>;

const fraction = (value: string): number => {
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  )
    return Number.NaN;
  return numerator / denominator;
};

const parseEvidence = (
  evidence: Record<string, unknown>,
  tenantId: string,
): {
  readonly sceneInput: EvidenceInput;
  readonly residualRgb16x9: readonly (readonly number[])[];
} => {
  const parsed = SceneEvidence.parse(evidence);
  if (parsed.sceneInput.tenantId !== tenantId)
    throw new Error("EVIDENCE_TENANT_MISMATCH");
  return {
    sceneInput: parsed.sceneInput,
    residualRgb16x9: parsed.observed.effects.map(
      (effect) => effect.lowerLightRgb16x9,
    ),
  };
};
export const compileEvidenceScene = (
  evidence: Record<string, unknown>,
  tenantId: string,
): Compilation =>
  compileScene(parseEvidence(evidence, tenantId).sceneInput, true);
const bindCompilation = (
  evidence: Record<string, unknown>,
  tenantId: string,
  expected: unknown,
): Compilation => {
  const parsed = CompilationSchema.parse(expected);
  const compilation = compileEvidenceScene(evidence, tenantId);
  if (
    compilation.authoring.digest !== parsed.authoring.digest ||
    compilation.scene.digest !== parsed.scene.digest ||
    compilation.browserPassSpec.digest !== parsed.browserPassSpec.digest
  )
    throw new Error("IR_VERSION_MISMATCH");
  return compilation;
};

const validateDelivery = (raw: string): Record<string, Json> => {
  const probe = Probe.parse(JSON.parse(raw));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const keyFrames = probe.frames
    .filter((frame) => frame.media_type === "video")
    .flatMap((frame, index) => (frame.key_frame === 1 ? [index] : []));
  const duration = Number(probe.format.duration);
  if (
    !video ||
    !audio ||
    video.codec_name !== "h264" ||
    video.profile !== "High" ||
    video.level !== 41 ||
    video.width !== 1080 ||
    video.height !== 1920 ||
    video.pix_fmt !== "yuv420p" ||
    Number(video.nb_read_frames) !== DELIVERY_FRAME_COUNT ||
    fraction(video.avg_frame_rate) !== DELIVERY_FPS ||
    video.color_space !== "bt709" ||
    video.color_transfer !== "bt709" ||
    video.color_primaries !== "bt709" ||
    keyFrames.length !== DELIVERY_FRAME_COUNT / DELIVERY_GOP ||
    keyFrames.some((frame, index) => frame !== index * DELIVERY_GOP) ||
    audio.codec_name !== "aac" ||
    audio.profile !== "LC" ||
    audio.channels !== 2 ||
    audio.sample_rate !== "48000" ||
    !Number.isFinite(duration) ||
    Math.abs(duration - 4) > 0.05
  )
    throw new Error("DELIVERY_QC_FAILED");
  return {
    status: "PASS",
    durationMs: Math.round(duration * 1_000),
    width: video.width,
    height: video.height,
    frameCount: DELIVERY_FRAME_COUNT,
    fps: DELIVERY_FPS,
    videoCodec: video.codec_name,
    videoProfile: video.profile,
    videoLevel: "4.1",
    pixelFormat: video.pix_fmt,
    colorSpace: video.color_space,
    gopSize: DELIVERY_GOP,
    closedGop: true,
    fastStart: true,
    audioCodec: audio.codec_name,
    audioProfile: audio.profile,
    audioTargetBitRate: DELIVERY_AUDIO_BIT_RATE,
    audioChannels: audio.channels,
    audioSampleRateHz: Number(audio.sample_rate),
  };
};

export async function renderWorkflowDelivery(
  input: RenderDeliveryInput,
  dependencies: RenderDeliveryDependencies = {},
): Promise<Record<string, unknown>> {
  if (input.frameCount !== input.sourceFps * 4)
    throw new Error("TEMPORAL_CONTRACT_INVALID");
  const command = dependencies.runCommand ?? runCommand;
  const capture = dependencies.captureFrames ?? captureBrowserFrames;
  const parsed = parseEvidence(input.evidence, input.tenantId);
  const compilation = bindCompilation(
    input.evidence,
    input.tenantId,
    input.expectedCompilation,
  );
  const fontPath =
    dependencies.fontPath ??
    process.env.RVS_FONT_PATH ??
    "/opt/rvs/fonts/WantedSansVariable.ttf";
  const app = createRenderApp({
    browserPassSpec: compilation.browserPassSpec,
    scene: compilation.scene,
    owners: compilation.authoring.owners,
    localFonts: [{ family: "Wanted Sans", path: fontPath }],
  });
  if (parsed.residualRgb16x9.length !== input.frameCount)
    throw new Error("EVIDENCE_FRAME_COUNT_MISMATCH");
  const sourceFrames = Array.from(
    { length: DELIVERY_FRAME_COUNT },
    (_, frame) =>
      Math.min(
        input.frameCount - 1,
        Math.floor((frame * input.sourceFps) / DELIVERY_FPS),
      ),
  );
  const renderedFrames = sourceFrames.map((frame) => app.renderFrame(frame));
  const residualRgb16x9 = sourceFrames.map((frame) => {
    const field = parsed.residualRgb16x9[frame];
    if (!field) throw new Error("EVIDENCE_FRAME_COUNT_MISMATCH");
    return field;
  });
  const framesDirectory = join(input.workspace, "frames");
  const audioPath = join(input.workspace, "audio.wav");
  await mkdir(framesDirectory, { recursive: true });
  const captureReport = await capture({
    workspace: input.workspace,
    framesDirectory,
    chromePath:
      dependencies.chromePath ??
      process.env.CHROME_PATH ??
      "/opt/chrome/chrome",
    fontPath,
    frames: renderedFrames,
    residualRgb16x9,
    signal: input.signal,
    onFrame: input.onProgress,
    renderContract: {
      kind: "workflow",
      browserPassSpec: compilation.browserPassSpec,
      scene: compilation.scene,
    },
  });

  await command(
    process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-i",
      input.normalizedPath,
      "-map",
      "0:a:0",
      "-vn",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  await command(
    process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-framerate",
      String(DELIVERY_FPS),
      "-start_number",
      "0",
      "-i",
      join(framesDirectory, "frame-%06d.png"),
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-frames:v",
      String(DELIVERY_FRAME_COUNT),
      "-af",
      "apad=pad_dur=4,atrim=duration=4,aresample=48000:async=0",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level:v",
      "4.1",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-g",
      String(DELIVERY_GOP),
      "-keyint_min",
      String(DELIVERY_GOP),
      "-sc_threshold",
      "0",
      "-flags",
      "+cgop",
      "-x264-params",
      "colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-pix_fmt",
      "yuv420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  const probe = await command(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_frames",
      "-show_format",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,profile,level,width,height,pix_fmt,avg_frame_rate,nb_read_frames,color_space,color_transfer,color_primaries,channels,sample_rate:frame=media_type,key_frame",
      "-of",
      "json",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  const qc = validateDelivery(probe.stdout);
  const outputHash = createHash("sha256");
  for await (const chunk of createReadStream(input.outputPath))
    outputHash.update(chunk);
  const output = await stat(input.outputPath);
  return {
    status: "PASS",
    protocol: "rvs.render-report.v1",
    mode: input.mode,
    jobId: input.jobId,
    attemptId: input.attemptId,
    outputSha256: outputHash.digest("hex"),
    outputBytes: output.size,
    ir: {
      authoringDigest: compilation.authoring.digest,
      sceneDigest: compilation.scene.digest,
      browserPassSpecDigest: compilation.browserPassSpec.digest,
    },
    runtime: captureReport,
    qc,
  };
}
