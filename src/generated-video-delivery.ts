import { stat } from "node:fs/promises";
import type { SceneSpec } from "./contracts/index.js";
import {
  mergeDeliveryProbes,
  validateDeliveryQc,
} from "./ffprobe-qc.js";
import type { CommandRunner } from "./process-runner.js";
import { RESOURCE_BUDGETS } from "./resource-budgets.js";
import type { ValidatedAudio } from "./audio-decoder.js";

const validate = (
  metadataRaw: string,
  framesRaw: string,
  audioRaw: string,
  canvas: SceneSpec["canvas"],
  audioSource?: ValidatedAudio,
): Record<string, unknown> => {
  const { video, duration } = validateDeliveryQc(
    mergeDeliveryProbes(metadataRaw, framesRaw, audioRaw),
    canvas,
    { errorToken: "GENERATED_DELIVERY_QC_FAILED" },
  );
  return {
    status: "PASS",
    width: video.width,
    height: video.height,
    fps: canvas.fps,
    frameCount: canvas.frameCount,
    durationMs: Math.round(duration * 1_000),
    videoCodec: "h264",
    videoProfile: "high",
    videoLevel: "4.1",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    audioCodec: "aac",
    audioProfile: "aac_low",
    audioTargetBitRate: 192_000,
    audioSource: audioSource
      ? {
          sha256: audioSource.sha256,
          durationMs: Math.round(audioSource.durationSeconds * 1_000),
          gainDb: audioSource.gainDb,
          durationPolicy: audioSource.durationPolicy,
        }
      : { kind: "deterministic-silence" },
  };
};

export async function assembleGeneratedVideo(
  input: Readonly<{
    canvas: SceneSpec["canvas"];
    framesDirectory: string;
    outputPath: string;
    workspace: string;
    signal: AbortSignal;
    audio?: ValidatedAudio;
  }>,
  run: CommandRunner,
): Promise<Record<string, unknown>> {
  const duration = input.canvas.frameCount / input.canvas.fps;
  const audioInput = input.audio
    ? ["-i", input.audio.path]
    : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
  const audioFilter = input.audio
    ? [
        `volume=${input.audio.gainDb}dB`,
        ...(input.audio.durationPolicy === "pad"
          ? [`apad=pad_dur=${duration}`]
          : []),
        `atrim=duration=${duration}`,
        "asetpts=PTS-STARTPTS",
      ].join(",")
    : `atrim=duration=${duration},asetpts=PTS-STARTPTS`;
  await run(
    process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-framerate",
      String(input.canvas.fps),
      "-start_number",
      "0",
      "-i",
      `${input.framesDirectory}/frame-%06d.png`,
      ...audioInput,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-frames:v",
      String(input.canvas.frameCount),
      "-t",
      String(duration),
      "-af",
      audioFilter,
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
      "60",
      "-keyint_min",
      "60",
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
  try {
    const muxed = await stat(input.outputPath);
    if (muxed.size > RESOURCE_BUDGETS.maxFfmpegOutputBytes)
      throw new Error("RESOURCE_BUDGET_EXCEEDED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const metadata = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_streams",
      "-show_format",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,profile,level,width,height,pix_fmt,avg_frame_rate,nb_read_frames",
      "-of",
      "json=compact=1",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  const frames = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=media_type,key_frame",
      "-of",
      "json=compact=1",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  const audio = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_streams",
      "-show_entries",
      "stream=codec_type,codec_name,profile,channels,sample_rate",
      "-of",
      "json=compact=1",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  return validate(
    metadata.stdout,
    frames.stdout,
    audio.stdout,
    input.canvas,
    input.audio,
  );
}
