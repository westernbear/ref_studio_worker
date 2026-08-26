import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(filter).toContain("enable='eq(n\\,0)'");
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
      "drawbox=x=0:y=ih-12:w=iw:h=12:color=orange@0.7:thickness=fill:enable='eq(n\\,30)'",
    );
  });

  it("escapes apostrophes and percent signs in drawtext labels", () => {
    // A bbox track, because that is the kind that actually draws text -- the
    // ocr-text kind draws only a box, so asserting on it tested nothing.
    const tracks: EvidenceTrack[] = [
      {
        ownerId: "text-0",
        kind: "bbox",
        label: "50% off: today's sale",
        frames: [{ frame: 0, bounds: [0, 0, 10, 10], confidence: 0.5 }],
      },
    ];
    const filter = buildEvidenceOverlayFilter(tracks, { fps: 30 });
    // A bare apostrophe closes the option early and takes the whole graph
    // down with it; a bare % is silently eaten by ffmpeg's text expander.
    expect(filter).not.toMatch(/text='[^']*'[a-z]/u);
    expect(filter).toContain("\\u0027");
    expect(filter).toContain("50\\% off");
  });

  it("drops the densest tracks rather than building an unrenderable graph", () => {
    const dense = (ownerId: string, frames: number): EvidenceTrack => ({
      ownerId,
      kind: "trajectory",
      label: ownerId,
      frames: Array.from({ length: frames }, (_unused, frame) => ({
        frame,
        point: [1, 1] as const,
        confidence: 1,
      })),
    });
    const filter = buildEvidenceOverlayFilter(
      [dense("a", 5_000), dense("b", 10)],
      { fps: 30 },
    );
    expect(filter.split("drawbox").length - 1).toBe(10);
  });
});

describe("renderEvidenceVideo", () => {
  let workspace = "";
  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = "";
  });

  it("writes the filter to a file and passes it via -filter_script:v (never as an argv string)", async () => {
    workspace = await mkdtemp(join(tmpdir(), "rvs-evidence-video-test-"));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const command: CommandRunner = async (cmd, args) => {
      calls.push({ command: cmd, args });
      return { stdout: "", stderr: "" };
    };
    await renderEvidenceVideo(
      {
        normalizedPath: join(workspace, "normalized.mkv"),
        outputPath: join(workspace, "evidence.mp4"),
        workspace,
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
    expect(calls[0]?.args).not.toContain("-vf");
    expect(calls[0]?.args).toContain("-filter_script:v");
    const filterPath = join(workspace, "evidence-overlay-filter.txt");
    expect(calls[0]?.args).toContain(filterPath);
    const filterContents = await readFile(filterPath, "utf8");
    expect(filterContents).toContain("drawbox=x=10:y=20:w=100:h=200:color=yellow@0.8");
    expect(calls[0]?.args).toContain(join(workspace, "evidence.mp4"));
    expect(calls[0]?.args).toContain("aac");
  });

  it("omits -filter_script:v when there are no tracks", async () => {
    workspace = await mkdtemp(join(tmpdir(), "rvs-evidence-video-test-"));
    const calls: string[][] = [];
    const command: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "" };
    };
    await renderEvidenceVideo(
      {
        normalizedPath: join(workspace, "normalized.mkv"),
        outputPath: join(workspace, "evidence.mp4"),
        workspace,
        tracks: [],
        fps: 30,
        signal: new AbortController().signal,
      },
      command,
    );
    expect(calls[0]).not.toContain("-vf");
    expect(calls[0]).not.toContain("-filter_script:v");
  });
});

describe("label placement", () => {
  it("drops a name inside its box when the box touches the top edge", () => {
    const filter = buildEvidenceOverlayFilter([
      {
        trackId: "t-top",
        kind: "bbox",
        label: "global-residual",
        frames: [{ frame: 0, bounds: [532, 0, 516, 870] }],
      },
      {
        trackId: "t-near",
        kind: "bbox",
        label: "ui-surface-05",
        frames: [{ frame: 0, bounds: [557, 5, 211, 159] }],
      },
    ]);
    // Neither name may land on y=0 -- that is where they used to collide.
    expect(filter).toContain("text='global-residual':x=532:y=26");
    expect(filter).toContain("text='ui-surface-05':x=557:y=31");
    expect(filter).not.toContain(":y=0:fontsize=20");
  });

  it("keeps a name above its box when there is room", () => {
    const filter = buildEvidenceOverlayFilter([
      {
        trackId: "t-mid",
        kind: "bbox",
        label: "ui-surface-04",
        frames: [{ frame: 0, bounds: [835, 140, 170, 175] }],
      },
    ]);
    expect(filter).toContain("text='ui-surface-04':x=835:y=116");
  });
});
