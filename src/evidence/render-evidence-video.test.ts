import { describe, expect, it } from "vitest";
import { buildEvidenceOverlayFilter, renderEvidenceVideo } from "./render-evidence-video.js";
import type { EvidenceTrack } from "./tracks.js";
import type { CommandRunner } from "../process-runner.js";

describe("buildEvidenceOverlayFilter", () => {
  it("returns an empty string for no tracks", () => {
    expect(buildEvidenceOverlayFilter([], { fps: 30 })).toBe("");
  });

  it("emits a drawbox+drawtext pair per bbox frame, timed to that frame", () => {
    const tracks: EvidenceTrack[] = [
      {
        ownerId: "foreground-subject",
        kind: "bbox",
        label: "foreground-subject",
        frames: [{ frame: 0, bounds: [10, 20, 100, 200], confidence: 0.9 }],
      },
    ];
    const filter = buildEvidenceOverlayFilter(tracks, { fps: 30 });
    expect(filter).toContain("drawbox=x=10:y=20:w=100:h=200:color=yellow@0.8");
    expect(filter).toContain("enable='between(t\\,0.000\\,0.033)'");
    expect(filter).toContain("drawtext=text='foreground-subject'");
  });

  it("emits a small drawbox dot per trajectory point", () => {
    const tracks: EvidenceTrack[] = [
      {
        ownerId: "foreground-subject",
        kind: "trajectory",
        label: "foreground-subject",
        frames: [{ frame: 5, point: [60, 120], confidence: 0.9 }],
      },
    ];
    const filter = buildEvidenceOverlayFilter(tracks, { fps: 30 });
    expect(filter).toContain("drawbox=x=57:y=117:w=6:h=6:color=cyan@0.9:thickness=fill");
  });

  it("emits a full-width bottom strip per audio-anchor frame", () => {
    const tracks: EvidenceTrack[] = [
      {
        ownerId: "global-residual",
        kind: "audio-anchor",
        label: "beat",
        frames: [{ frame: 30, confidence: 0.7 }],
      },
    ];
    const filter = buildEvidenceOverlayFilter(tracks, { fps: 30 });
    expect(filter).toBe(
      "drawbox=x=0:y=ih-12:w=iw:h=12:color=orange@0.7:thickness=fill:enable='between(t\\,1.000\\,1.033)'",
    );
  });

  it("escapes colons and quotes in drawtext labels", () => {
    const tracks: EvidenceTrack[] = [
      {
        ownerId: "text-0",
        kind: "ocr-text",
        label: "50% off: today's sale",
        frames: [{ frame: 0, bounds: [0, 0, 10, 10], confidence: 0.5 }],
      },
    ];
    const filter = buildEvidenceOverlayFilter(tracks, { fps: 30 });
    expect(filter).toContain("drawbox=x=0:y=0:w=10:h=10:color=lime@0.6:thickness=2");
  });
});

describe("renderEvidenceVideo", () => {
  it("invokes ffmpeg with the generated filter and copies audio", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const command: CommandRunner = async (cmd, args) => {
      calls.push({ command: cmd, args });
      return { stdout: "", stderr: "" };
    };
    await renderEvidenceVideo(
      {
        normalizedPath: "/work/normalized.mkv",
        outputPath: "/work/evidence.mp4",
        workspace: "/work",
        tracks: [
          {
            ownerId: "foreground-subject",
            kind: "bbox",
            label: "foreground-subject",
            frames: [{ frame: 0, bounds: [10, 20, 100, 200], confidence: 0.9 }],
          },
        ],
        fps: 30,
        signal: new AbortController().signal,
      },
      command,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("ffmpeg");
    expect(calls[0]?.args).toContain("-vf");
    expect(calls[0]?.args).toContain("/work/evidence.mp4");
    expect(calls[0]?.args).toContain("copy");
  });

  it("omits -vf when there are no tracks", async () => {
    const calls: string[][] = [];
    const command: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "" };
    };
    await renderEvidenceVideo(
      {
        normalizedPath: "/work/normalized.mkv",
        outputPath: "/work/evidence.mp4",
        workspace: "/work",
        tracks: [],
        fps: 30,
        signal: new AbortController().signal,
      },
      command,
    );
    expect(calls[0]).not.toContain("-vf");
  });
});
