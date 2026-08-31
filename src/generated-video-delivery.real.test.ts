import { mkdtemp, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS, DELIVERY_FPS, type SceneSpec } from "./contracts/index.js";
import { assembleGeneratedVideo } from "./generated-video-delivery.js";
import { runCommand } from "./process-runner.js";

const canvas: SceneSpec["canvas"] = {
  width: CANVAS["9:16"].width,
  height: CANVAS["9:16"].height,
  fps: DELIVERY_FPS,
  frameCount: 900,
};

describe("assembleGeneratedVideo real mux", () => {
  it.skipIf(process.env.RVS_REAL_900_MUX !== "1")(
    "muxes a real 900-frame H.264/AAC render and records PASS metadata",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "rvs-900-mux-"));
      const framesDirectory = join(workspace, "frames");
      const outputPath = join(workspace, "out.mp4");
      const signal = AbortSignal.timeout(1_800_000);
      await runCommand(
        process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=0x101018:s=${canvas.width}x${canvas.height}:d=1:r=1`,
          "-frames:v",
          "1",
          join(workspace, "seed.png"),
        ],
        { cwd: workspace, signal },
      );
      await runCommand("mkdir", ["-p", framesDirectory], {
        cwd: workspace,
        signal,
      });
      const seed = join(workspace, "seed.png");
      for (let frame = 0; frame < canvas.frameCount; frame += 1) {
        const name = `frame-${String(frame).padStart(6, "0")}.png`;
        try {
          await symlink(seed, join(framesDirectory, name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await unlink(join(framesDirectory, name));
          await symlink(seed, join(framesDirectory, name));
        }
      }
      const result = await assembleGeneratedVideo(
        { canvas, framesDirectory, outputPath, workspace, signal },
        runCommand,
      );
      expect(result).toMatchObject({
        status: "PASS",
        width: canvas.width,
        height: canvas.height,
        fps: canvas.fps,
        frameCount: canvas.frameCount,
        videoCodec: "h264",
        audioCodec: "aac",
      });
    },
    1_800_000,
  );
});
