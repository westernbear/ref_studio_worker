import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runCommand, type CommandRunner } from "./process-runner.js";

const ProbeSchema = z.object({
  streams: z.array(
    z
      .object({
        codec_type: z.string(),
        codec_name: z.string().optional(),
        pix_fmt: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        avg_frame_rate: z.string().optional(),
        nb_read_frames: z.string().optional(),
        color_space: z.string().optional(),
        color_transfer: z.string().optional(),
        color_primaries: z.string().optional(),
      })
      .passthrough(),
  ),
});
const FrameProbeSchema = z.object({
  frames: z.array(
    z
      .object({
        media_type: z.literal("video"),
        pix_fmt: z.string(),
        color_space: z.string(),
        color_transfer: z.string(),
        color_primaries: z.string(),
      })
      .passthrough(),
  ),
});

export class VideoDecodeError extends Error {
  readonly token = "VIDEO_DECODE_UNSUPPORTED";
  constructor() {
    super("VIDEO_DECODE_UNSUPPORTED");
    this.name = "VideoDecodeError";
  }
}

export type VideoDecodeReport = Readonly<{
  assetId: string;
  decoderFingerprint: string;
  probeFingerprint: string;
  pixelFormat: "rgb24";
  colorSpace: "bt709";
  frameSha256: readonly string[];
}>;

export type DecodedVideo = Readonly<{
  framePaths: readonly string[];
  report: VideoDecodeReport;
}>;

const fraction = (value: string | undefined): number => {
  const [numerator, denominator] = (value ?? "").split("/").map(Number);
  return numerator && denominator ? numerator / denominator : Number.NaN;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export async function decodeVideoAsset(
  input: Readonly<{
    assetId: string;
    bytes: Uint8Array;
    expectedSha256: string;
    contentType: string;
    canvas: Readonly<{
      width: number;
      height: number;
      fps: number;
      frameCount: number;
    }>;
    workspace: string;
    signal: AbortSignal;
  }>,
  run: CommandRunner = runCommand,
): Promise<DecodedVideo> {
  const directory = join(input.workspace, "decoded-video", input.assetId);
  try {
    if (
      !/^[A-Za-z0-9._-]+$/u.test(input.assetId) ||
      input.contentType !== "video/mp4" ||
      input.bytes.byteLength === 0 ||
      sha256(input.bytes) !== input.expectedSha256
    )
      throw new VideoDecodeError();
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const inputPath = join(directory, "input.mp4");
    await writeFile(inputPath, input.bytes, { mode: 0o600 });
    const ffmpeg = process.env.RVS_FFMPEG_PATH ?? "ffmpeg";
    const ffprobe = process.env.RVS_FFPROBE_PATH ?? "ffprobe";
    const [decoder, probeRuntime] = await Promise.all([
      run(ffmpeg, ["-version"], { cwd: directory, signal: input.signal }),
      run(ffprobe, ["-version"], { cwd: directory, signal: input.signal }),
    ]);
    const metadata = await run(
      ffprobe,
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames,color_space,color_transfer,color_primaries",
        "-of",
        "json",
        inputPath,
      ],
      { cwd: directory, signal: input.signal },
    );
    const parsed = ProbeSchema.parse(JSON.parse(metadata.stdout));
    const video = parsed.streams.find(
      (stream) => stream.codec_type === "video",
    );
    if (
      !video ||
      video.codec_name !== "h264" ||
      video.pix_fmt !== "yuv420p" ||
      video.width !== input.canvas.width ||
      video.height !== input.canvas.height ||
      fraction(video.avg_frame_rate) !== input.canvas.fps ||
      Number(video.nb_read_frames) !== input.canvas.frameCount ||
      video.color_space !== "bt709" ||
      video.color_transfer !== "bt709" ||
      video.color_primaries !== "bt709"
    )
      throw new VideoDecodeError();
    const frameProbe = await run(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-read_intervals",
        "%+#1",
        "-show_frames",
        "-show_entries",
        "frame=media_type,pix_fmt,color_space,color_transfer,color_primaries",
        "-of",
        "json=compact=1",
        inputPath,
      ],
      { cwd: directory, signal: input.signal },
    );
    const decodedFrame = FrameProbeSchema.parse(JSON.parse(frameProbe.stdout))
      .frames[0];
    if (
      !decodedFrame ||
      decodedFrame.pix_fmt !== "yuv420p" ||
      decodedFrame.color_space !== "bt709" ||
      decodedFrame.color_transfer !== "bt709" ||
      decodedFrame.color_primaries !== "bt709"
    )
      throw new VideoDecodeError();
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-an",
        "-vsync",
        "0",
        "-frames:v",
        String(input.canvas.frameCount),
        "-pix_fmt",
        "rgb24",
        "-threads",
        "1",
        join(directory, "frame-%06d.png"),
      ],
      { cwd: directory, signal: input.signal },
    );
    const names = (await readdir(directory))
      .filter((name) => /^frame-\d{6}\.png$/u.test(name))
      .sort();
    if (names.length !== input.canvas.frameCount) throw new VideoDecodeError();
    const framePaths = names.map((name) => join(directory, name));
    const frameSha256 = await Promise.all(
      framePaths.map(async (path) => sha256(await readFile(path))),
    );
    return {
      framePaths,
      report: {
        assetId: input.assetId,
        decoderFingerprint: decoder.stdout.split("\n", 1)[0]?.trim() ?? "",
        probeFingerprint: probeRuntime.stdout.split("\n", 1)[0]?.trim() ?? "",
        pixelFormat: "rgb24",
        colorSpace: "bt709",
        frameSha256,
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (
      input.signal.aborted ||
      (error instanceof Error && error.message === "WORKER_JOB_CANCELLED")
    )
      throw new Error("WORKER_JOB_CANCELLED");
    throw error instanceof VideoDecodeError ? error : new VideoDecodeError();
  }
}
