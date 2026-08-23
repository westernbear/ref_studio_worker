import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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
  type EvidenceInput,
  type Json,
} from "./scene/compile.js";

const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const ResidualRgb16x9 = z.array(z.number().min(0).max(1)).length(16 * 9 * 3);
const SceneEvidence = z.object({
  observed: z.object({
    palette: z.tuple([HexColor, HexColor]).rest(HexColor),
    effects: z.array(
      z.object({
        lowerLightRgb16x9: ResidualRgb16x9,
      }),
    ),
  }),
  sceneInput: z
    .object({
      tenantId: z.string().min(1),
      editor: z.string().min(1),
      reason: z.string().min(1),
      timestamp: z.string().min(1),
      gate: z.enum(["APPROVED", "PENDING", "REJECTED"]),
      needsChoice: z.array(z.unknown()).optional(),
      owners: z.array(z.record(z.string(), z.unknown())),
      editableAssets: z.array(z.record(z.string(), z.unknown())),
      geometry: z.record(z.string(), z.record(z.string(), z.unknown())),
      tracks: z.array(z.record(z.string(), z.unknown())),
      effects: z.record(
        z.string(),
        z.record(z.string(), z.record(z.string(), z.unknown())),
      ),
      residualCanvas: z.record(z.string(), z.unknown()),
      audio: z.record(z.string(), z.unknown()),
      passes: z.array(z.record(z.string(), z.unknown())),
      layerOrder: z.array(z.string().min(1)),
      allowedShaders: z.array(z.string().min(1)),
    })
    .strict(),
});
const Probe = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(
    z.object({
      codec_type: z.enum(["video", "audio"]),
      codec_name: z.string(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      avg_frame_rate: z.string().optional(),
      nb_read_frames: z.string().optional(),
      channels: z.number().int().positive().optional(),
      sample_rate: z.string().optional(),
    }),
  ),
});

export type RenderDeliveryInput = Readonly<{
  mode: "preview" | "delivery";
  tenantId: string;
  jobId: string;
  attemptId: string;
  workspace: string;
  normalizedPath: string;
  outputPath: string;
  evidence: Record<string, unknown>;
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
  mode: RenderDeliveryInput["mode"],
): {
  readonly sceneInput: EvidenceInput;
  readonly residualRgb16x9: readonly (readonly number[])[];
} => {
  const parsed = SceneEvidence.parse(evidence);
  if (parsed.sceneInput.tenantId !== tenantId)
    throw new Error("EVIDENCE_TENANT_MISMATCH");
  const sceneInput = {
    ...parsed.sceneInput,
    gate: mode === "delivery" ? ("APPROVED" as const) : parsed.sceneInput.gate,
  } as unknown as EvidenceInput;
  return {
    sceneInput,
    residualRgb16x9: parsed.observed.effects.map(
      (effect) => effect.lowerLightRgb16x9,
    ),
  };
};

const validateDelivery = (
  raw: string,
  frameCount: number,
  sourceFps: number,
): Record<string, Json> => {
  const probe = Probe.parse(JSON.parse(raw));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format.duration);
  if (
    !video ||
    !audio ||
    video.codec_name !== "h264" ||
    video.width !== 1080 ||
    video.height !== 1920 ||
    Number(video.nb_read_frames) !== frameCount ||
    fraction(video.avg_frame_rate ?? "") !== sourceFps ||
    audio.codec_name !== "aac" ||
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
    frameCount,
    fps: sourceFps,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
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
  const parsed = parseEvidence(input.evidence, input.tenantId, input.mode);
  const compilation = compileScene(parsed.sceneInput, input.mode === "preview");
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
  const renderedFrames = Array.from({ length: input.frameCount }, (_, frame) =>
    app.renderFrame(frame),
  );
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
    residualRgb16x9: parsed.residualRgb16x9,
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
      String(input.sourceFps),
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
      String(input.frameCount),
      "-af",
      "apad=pad_dur=4,atrim=duration=4,aresample=48000:async=0",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
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
      "-show_format",
      "-of",
      "json",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  const qc = validateDelivery(probe.stdout, input.frameCount, input.sourceFps);
  const output = await readFile(input.outputPath);
  return {
    status: "PASS",
    protocol: "rvs.render-report.v1",
    mode: input.mode,
    jobId: input.jobId,
    attemptId: input.attemptId,
    outputSha256: createHash("sha256").update(output).digest("hex"),
    outputBytes: output.byteLength,
    ir: {
      authoringDigest: compilation.authoring.digest,
      sceneDigest: compilation.scene.digest,
      browserPassSpecDigest: compilation.browserPassSpec.digest,
    },
    runtime: captureReport,
    qc,
  };
}
