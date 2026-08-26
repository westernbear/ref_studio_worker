import { describe, expect, it } from "vitest";
import {
  compileScene,
  type EvidenceInput,
  type Pass,
  type Track,
} from "../scene/compile.js";
import { createRenderApp, RenderAppError, type RenderInput } from "./index.js";

const track: Track = {
  trackId: "title-track",
  owner: "title",
  lifecycle: {
    enter: { start: 0 },
    stable: { start: 1 },
    exit: { start: 120 },
  },
  geometryRef: "title",
  effects: [],
};
const residualTrack: Track = {
  trackId: "residual-track",
  owner: "residual",
  lifecycle: {
    enter: { start: 0 },
    stable: { start: 1 },
    exit: { start: 120 },
  },
  geometryRef: "residual",
  effects: ["residual-canvas"],
};
const pass: Pass = {
  passId: "title-pass",
  owner: "title",
  kind: "DOM/SVG",
  shader: null,
  reads: ["font"],
  writes: "copy-layer",
};
const evidence: EvidenceInput = {
  tenantId: "ten_fixture",
  editor: "usr_editor",
  reason: "T25",
  timestamp: "2026-08-22T00:00:00.000Z",
  owners: [
    {
      ownerId: "title",
      kind: "text-word",
      editable: true,
      assetRef: "font",
      confidence: 1,
      content: "분석",
    },
    {
      ownerId: "residual",
      kind: "global-residual",
      editable: true,
      assetRef: "background",
      confidence: 1,
    },
  ],
  editableAssets: [
    { assetId: "font", kind: "font", editable: true, owner: "title" },
    {
      assetId: "background",
      kind: "background",
      editable: true,
      owner: "residual",
    },
  ],
  geometry: {
    title: {
      boundsPerFrame: [0, 59, 70, 119].map((frame) => ({
        frame,
        x: frame,
        y: 2,
        width: 300,
        height: 40,
      })),
      fixedWidth: false,
      fixedX: false,
    },
    residual: {
      boundsPerFrame: [{ frame: 0, x: 0, y: 0, width: 1080, height: 1920 }],
      fixedWidth: true,
      fixedX: true,
    },
  },
  tracks: [track, residualTrack],
  effects: {},
  residualCanvas: {
    owner: "residual",
    measurements: [],
    mustRemainSeparate: true,
    compositeRule: "before owner effects",
  },
  audio: { sampleRateHz: 48000, channels: 2, anchors: [] },
  passes: [
    pass,
    {
      passId: "residual-pass",
      owner: "residual",
      kind: "DOM/SVG",
      shader: null,
      reads: ["background"],
      writes: "background-layer",
    },
  ],
  layerOrder: ["background-layer", "copy-layer"],
  allowedShaders: [],
};
const compilation = compileScene(evidence);
const input = (overrides: Partial<RenderInput> = {}): RenderInput => ({
  browserPassSpec: compilation.browserPassSpec,
  scene: compilation.scene,
  owners: evidence.owners,
  assets: evidence.editableAssets,
  localFonts: [{ family: "Inter", path: "fonts/Inter.woff2" }],
  ...overrides,
});

describe("semantic DOM/SVG renderer", () => {
  it.each([0, 59, 70, 119])(
    "renders golden frame %s from frame index",
    (frame) => {
      const rendered = createRenderApp(input()).renderFrame(frame);
      expect(rendered.frame).toBe(frame);
      expect(rendered.markup).toContain(`data-frame="${frame}"`);
      expect(rendered.markup).toContain("분석");
      expect(rendered.markup).toContain(`<text data-owner-id="title"`);
      expect(rendered.markup).toContain(
        `font-size="37" textLength="300" lengthAdjust="spacingAndGlyphs"`,
      );
    },
  );
  it("is identity-stable for repeated frames", () => {
    const app = createRenderApp(input());
    expect(app.renderFrame(70)).toEqual(app.renderFrame(70));
  });
  it.each([
    [
      "remote font",
      {
        localFonts: [
          { family: "Inter", path: "https://fonts.example/font.woff2" },
        ],
      },
      "REMOTE_FONT_URL_REJECTED",
    ],
    [
      "empty font path",
      { localFonts: [{ family: "Inter", path: "" }] },
      "LOCAL_FONT_PATH_INVALID",
    ],
    [
      "non-font local path",
      {
        localFonts: [{ family: "Inter", path: "fonts/font.css" }],
      },
      "LOCAL_FONT_PATH_INVALID",
    ],
  ] as const)("rejects %s", (_name, overrides, token) =>
    expect(() => createRenderApp(input(overrides))).toThrow(
      new RenderAppError(token),
    ),
  );
  it("keeps owners as semantic elements", () => {
    const rendered = createRenderApp(input()).renderFrame(70);
    expect(rendered.markup).not.toContain("<image");
    expect(rendered.markup).toContain('<text data-owner-id="title"');
  });
  it("paints owners with the measured palette instead of the stylesheet default", () => {
    // Without a fill the capture page's near-black placeholder is the only
    // colour available, so a correctly detected owner still renders invisible.
    const markup = createRenderApp(
      input({
        assets: [
          {
            assetId: "font",
            kind: "font",
            editable: true,
            owner: "title",
            palette: ["#101014", "#5b3ea8", "#f2c14e"],
          },
          ...evidence.editableAssets.filter((asset) => asset.owner !== "title"),
        ],
      }),
    ).renderFrame(0).markup;
    // Light end for text, so it reads against the scene behind it.
    expect(markup).toContain('fill="#f2c14e"');
  });

  it("omits fill when the compiler measured no palette", () => {
    expect(createRenderApp(input()).renderFrame(0).markup).not.toContain("fill=");
  });

  it("rejects unknown geometry references", () => {
    const badScene = {
      ...compilation.scene,
      tracks: [{ ...track, geometryRef: "unknown" }, residualTrack],
    };
    expect(() =>
      createRenderApp(input({ scene: badScene })).renderFrame(0),
    ).toThrow("UNKNOWN_GEOMETRY_REFERENCE");
  });
  it("does not contain forbidden nondeterministic APIs", async () => {
    const source = await import("node:fs/promises");
    const file = await source.readFile(
      new URL("./index.ts", import.meta.url),
      "utf8",
    );
    expect(file).not.toMatch(
      /Date\.now|new Date|Math\.random|requestAnimationFrame/,
    );
  });
});
