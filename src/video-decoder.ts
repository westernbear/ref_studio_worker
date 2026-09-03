import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  h264CanvasMismatch,
  parseFfprobeJson,
  videoStream,
} from "./ffprobe-qc.js";
import { runCommand, type CommandRunner } from "./process-runner.js";

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

const isOwnedPath = (owner: string, candidate: string): boolean => {
  const path = relative(owner, candidate);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
};

const ownedDecodeDirectory = (workspace: string, assetId: string): string => {
  if (
    !/^[A-Za-z0-9._-]+$/u.test(assetId) ||
    assetId === "." ||
    assetId === ".."
  )
    throw new VideoDecodeError();
  const owner = resolve(workspace, "decoded-video");
  const directory = resolve(owner, assetId);
  if (!isOwnedPath(owner, directory)) throw new VideoDecodeError();
  return directory;
};

const ownedOutputPath = (directory: string, name: string): string => {
  const path = resolve(directory, name);
  if (!isOwnedPath(directory, path)) throw new VideoDecodeError();
  return path;
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
  let directory: string | undefined;
  try {
    directory = ownedDecodeDirectory(input.workspace, input.assetId);
    if (
      input.contentType !== "video/mp4" ||
      input.bytes.byteLength === 0 ||
      sha256(input.bytes) !== input.expectedSha256
    )
      throw new VideoDecodeError();
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const inputPath = ownedOutputPath(directory, "input.mp4");
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
    const parsed = parseFfprobeJson(metadata.stdout);
    const video = videoStream(parsed);
    if (h264CanvasMismatch(video, input.canvas, true))
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
    const decodedFrame = parseFfprobeJson(frameProbe.stdout).frames[0];
    if (
      decodedFrame?.media_type !== "video" ||
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
        ownedOutputPath(directory, "frame-%06d.png"),
      ],
      { cwd: directory, signal: input.signal },
    );
    const names = (await readdir(directory))
      .filter((name) => /^frame-\d{6}\.png$/u.test(name))
      .sort();
    if (names.length !== input.canvas.frameCount) throw new VideoDecodeError();
    const decodedDirectory = directory;
    const framePaths = names.map((name) =>
      ownedOutputPath(decodedDirectory, name),
    );
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
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
    if (
      input.signal.aborted ||
      (error instanceof Error && error.message === "WORKER_JOB_CANCELLED")
    )
      throw new Error("WORKER_JOB_CANCELLED");
    throw error instanceof VideoDecodeError ? error : new VideoDecodeError();
  }
}
