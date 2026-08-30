import { describe, expect, it } from "vitest";
import { CANVAS, DELIVERY_FPS, type SceneSpec } from "./contracts/index.js";
import { assembleGeneratedVideo } from "./generated-video-delivery.js";
import type { CommandRunner } from "./process-runner.js";

const canvas: SceneSpec["canvas"] = {
  width: CANVAS["9:16"].width,
  height: CANVAS["9:16"].height,
  fps: DELIVERY_FPS,
  frameCount: 900,
};

const metadataProbe = {
  format: { duration: "30.000000" },
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: canvas.width,
      height: canvas.height,
      pix_fmt: "yuv420p",
      avg_frame_rate: `${canvas.fps}/1`,
      nb_read_frames: String(canvas.frameCount),
      profile: "High",
      level: 41,
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      profile: "LC",
      channels: 2,
      sample_rate: "48000",
    },
  ],
};

const videoFrames = Array.from({ length: canvas.frameCount }, (_, frame) => ({
  media_type: "video",
  key_frame: frame % 60 === 0 ? 1 : 0,
}));

describe("assembleGeneratedVideo", () => {
  it("keeps a 30-second ffprobe document within the bounded stdout capture", async () => {
    // Given
    const combinedProbe = JSON.stringify({
      ...metadataProbe,
      frames: [
        ...videoFrames,
        ...Array.from({ length: 1_407 }, () => ({ media_type: "audio" })),
      ],
    });
    const run: CommandRunner = async (command, args) => {
      if (!command.endsWith("ffprobe")) return { stdout: "", stderr: "" };
      const stdout = args.includes("-select_streams")
        ? JSON.stringify({ frames: videoFrames })
        : args.includes("-show_frames")
          ? combinedProbe
          : JSON.stringify(metadataProbe);
      return {
        stdout: stdout.slice(-(64 * 1024)),
        stderr: "",
      };
    };

    // When
    const result = assembleGeneratedVideo(
      {
        canvas,
        framesDirectory: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        workspace: "/tmp",
        signal: new AbortController().signal,
      },
      run,
    );

    // Then
    await expect(result).resolves.toMatchObject({ status: "PASS" });
  });
});
