import { describe, expect, it } from "vitest";
import { projectEvidenceTracks } from "./tracks.js";

const bundle = (): Record<string, unknown> => ({
  sceneInput: {
    owners: [
      { ownerId: "foreground-subject", kind: "foreground-subject", confidence: 0.9 },
    ],
    geometry: {
      "foreground-subject": {
        boundsPerFrame: [
          { frame: 0, x: 10, y: 20, width: 100, height: 200 },
          { frame: 1, x: 12, y: 20, width: 100, height: 200 },
        ],
        fixedWidth: false,
        fixedX: false,
      },
    },
    tracks: [
      {
        trackId: "track-foreground-subject",
        owner: "foreground-subject",
        geometryRef: "foreground-subject",
        lifecycle: {},
        effects: ["bloom", "rim"],
      },
    ],
    audio: {
      sampleRateHz: 48_000,
      channels: 2,
      anchors: [
        {
          anchorId: "anchor-1",
          frame: 30,
          sample: 48_000,
          owner: "global-residual",
          role: "beat",
          confidence: 0.7,
        },
      ],
    },
  },
  observed: {
    ocr: {
      candidates: [
        { frame: 0, confidence: 0.95, text: "SALE", bounds: [5, 5, 40, 20] },
        { frame: 1, confidence: 0.93, text: "SALE", bounds: [6, 5, 40, 20] },
      ],
    },
  },
});

describe("projectEvidenceTracks", () => {
  it("projects one bbox and one trajectory track per owner geometry", () => {
    const tracks = projectEvidenceTracks(bundle());
    const bbox = tracks.find((t) => t.kind === "bbox");
    const trajectory = tracks.find((t) => t.kind === "trajectory");
    expect(bbox).toMatchObject({
      ownerId: "foreground-subject",
      kind: "bbox",
      frames: [
        { frame: 0, bounds: [10, 20, 100, 200], confidence: 0.9 },
        { frame: 1, bounds: [12, 20, 100, 200], confidence: 0.9 },
      ],
    });
    expect(trajectory).toMatchObject({
      ownerId: "foreground-subject",
      kind: "trajectory",
      frames: [
        { frame: 0, point: [60, 120], confidence: 0.9 },
        { frame: 1, point: [62, 120], confidence: 0.9 },
      ],
    });
  });

  it("projects one effect track labeling the owner's effect names", () => {
    const tracks = projectEvidenceTracks(bundle());
    const effect = tracks.find((t) => t.kind === "effect");
    expect(effect).toMatchObject({
      ownerId: "foreground-subject",
      kind: "effect",
      label: "bloom+rim",
    });
    expect(effect?.frames).toHaveLength(2);
  });

  it("groups OCR candidates sharing the same text into one track", () => {
    const tracks = projectEvidenceTracks(bundle());
    const ocrTracks = tracks.filter((t) => t.kind === "ocr-text");
    expect(ocrTracks).toHaveLength(1);
    expect(ocrTracks[0]).toMatchObject({ label: "SALE" });
    expect(ocrTracks[0]?.frames).toHaveLength(2);
  });

  it("projects one audio-anchor track per anchor", () => {
    const tracks = projectEvidenceTracks(bundle());
    const anchors = tracks.filter((t) => t.kind === "audio-anchor");
    expect(anchors).toEqual([
      {
        ownerId: "global-residual",
        kind: "audio-anchor",
        label: "beat",
        frames: [{ frame: 30, confidence: 0.7 }],
      },
    ]);
  });

  it("returns no tracks for an empty bundle", () => {
    expect(projectEvidenceTracks({})).toEqual([]);
  });
});
