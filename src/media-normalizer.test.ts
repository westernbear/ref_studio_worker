import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMedia } from "./media-normalizer.js";
import type { CommandRunner } from "./process-runner.js";

describe("normalizeMedia", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("center-crops a landscape source to the 9:16 compiler canvas", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-normalizer-"));
    const outputPath = join(workspace, "normalized.mkv");
    const calls: string[][] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "/opt/rvs/bin/ffprobe") {
        return {
          code: 0,
          stdout: JSON.stringify({
            format: {
              duration: "4.000",
              size: "1000",
              format_name: "mov,mp4,m4a,3gp,3g2,mj2",
            },
            streams: [
              {
                index: 0,
                codec_type: "video",
                codec_name: "h264",
                pix_fmt: "yuv420p",
                width: 1588,
                height: 870,
                avg_frame_rate: "30/1",
                r_frame_rate: "30/1",
                start_time: "0",
                tags: {},
              },
              {
                index: 1,
                codec_type: "audio",
                codec_name: "aac",
                channels: 2,
                sample_rate: "48000",
                tags: {},
              },
            ],
          }),
          stderr: "",
        };
      }
      await writeFile(outputPath, "normalized");
      return { code: 0, stdout: "", stderr: "" };
    };

    vi.stubEnv("RVS_FFPROBE_PATH", "/opt/rvs/bin/ffprobe");
    vi.stubEnv("RVS_FFMPEG_PATH", "/opt/rvs/bin/ffmpeg");

    await normalizeMedia(
      {
        inputPath: join(workspace, "source.mp4"),
        outputPath,
        startFrame: 0,
        sourceFps: 30,
        frameCount: 120,
        workspace,
        signal: new AbortController().signal,
      },
      run,
    );

    const filter = calls[1]?.[calls[1].indexOf("-vf") + 1];
    expect(calls.map(([command]) => command)).toEqual([
      "/opt/rvs/bin/ffprobe",
      "/opt/rvs/bin/ffmpeg",
    ]);
    expect(filter).toContain("crop=488:870:550:0");
    expect(calls[1]).toContain("+bitexact");
  });
});
