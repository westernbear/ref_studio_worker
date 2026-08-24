import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMedia } from "./media-normalizer.js";
import type { CommandRunner } from "./process-runner.js";

describe("normalizeMedia", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves landscape source dimensions for SceneIR fitting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-normalizer-"));
    const outputPath = join(workspace, "normalized.mkv");
    const calls: string[][] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "/opt/rvs/bin/ffprobe") {
        if (args.includes("-count_frames"))
          return {
            code: 0,
            stdout: JSON.stringify({
              streams: [{ nb_read_frames: "120" }],
            }),
            stderr: "",
          };
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

    const normalized = await normalizeMedia(
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
      "/opt/rvs/bin/ffprobe",
    ]);
    expect(calls[0]).not.toContain("-count_frames");
    expect(calls[2]).toContain("-count_frames");
    expect(calls[1]).toContain("-fflags");
    expect(calls[1]?.[calls[1].indexOf("-fflags") + 1]).toBe("+bitexact");
    expect(filter).not.toContain("scale=");
    expect(filter).not.toContain("pad=");
    expect(filter).not.toContain("crop=");
    expect(normalized.sha256).toBe(
      "b32b577d63a2a22e3a6b63b830d8b421e5f628091bfd3d9b9391b27c802fe23a",
    );
  });
});
