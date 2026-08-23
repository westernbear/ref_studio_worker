import { describe, expect, it } from "vitest"
import { compileScene, type EvidenceInput, type Pass, type Track } from "../scene/compile.js"
import { assertFrameReadBack, createRenderApp, RenderAppError, type RenderInput } from "./index.js"

const track: Track = { trackId: "title-track", owner: "title", lifecycle: { enter: { start: 0 }, stable: { start: 1 }, exit: { start: 120 } }, geometryRef: "title", effects: [] }
const residualTrack: Track = { trackId: "residual-track", owner: "residual", lifecycle: { enter: { start: 0 }, stable: { start: 1 }, exit: { start: 120 } }, geometryRef: "residual", effects: ["residual-canvas"] }
const pass: Pass = { passId: "title-pass", owner: "title", kind: "DOM/SVG", shader: null, reads: ["font"], writes: "copy-layer" }
const evidence: EvidenceInput = {
  tenantId: "ten_fixture", editor: "usr_editor", reason: "T25", timestamp: "2026-08-22T00:00:00.000Z", gate: "APPROVED",
  owners: [{ ownerId: "title", kind: "product-copy", editable: true, assetRef: "font", confidence: 1, content: "분석" }, { ownerId: "residual", kind: "residual-canvas", editable: true, assetRef: "background", confidence: 1 }],
  editableAssets: [{ assetId: "font", kind: "font", editable: true, owner: "title" }, { assetId: "background", kind: "background", editable: true, owner: "residual" }],
  geometry: { title: { boundsPerFrame: [0, 59, 70, 119].map((frame) => ({ frame, x: frame, y: 2, width: 300, height: 40 })), fixedWidth: false, fixedX: false }, residual: { boundsPerFrame: [{ frame: 0, x: 0, y: 0, width: 1080, height: 1920 }], fixedWidth: true, fixedX: true } },
  tracks: [track, residualTrack], effects: {}, residualCanvas: { owner: "residual", measurements: [], mustRemainSeparate: true, compositeRule: "before owner effects" },
  audio: { sampleRateHz: 48000, channels: 2, anchors: [] }, passes: [pass, { passId: "residual-pass", owner: "residual", kind: "DOM/SVG", shader: null, reads: ["background"], writes: "background-layer" }], layerOrder: ["background-layer", "copy-layer"], allowedShaders: [],
}
const compilation = compileScene(evidence)
const input = (overrides: Partial<RenderInput> = {}): RenderInput => ({ browserPassSpec: compilation.browserPassSpec, scene: compilation.scene, owners: evidence.owners, localFonts: [{ family: "Inter", path: "fonts/Inter.woff2", ready: true }], seed: "fixture-seed", ...overrides })

describe("semantic DOM/SVG renderer", () => {
  it.each([0, 59, 70, 119])("renders golden frame %s from frame index", (frame) => {
    const rendered = createRenderApp(input()).renderFrame(frame)
    assertFrameReadBack(rendered, frame)
    expect(rendered.nodes[0]?.content).toBe("분석")
    expect(rendered.markup).toContain(`<text data-owner-id="title"`)
  })
  it("is identity-stable for repeated frames", () => {
    const app = createRenderApp(input())
    expect(app.renderFrame(70)).toEqual(app.renderFrame(70))
  })
  it("uses renderFrame as the sole source for scrubbing, playback, and capture", () => {
    const app = createRenderApp(input())
    const frames = [0, 59, 70, 119] as const
    const scrubbed = frames.map((frame) => app.preview.scrub(frame))
    const played = app.preview.playback(frames)
    const captured: number[] = []
    frames.forEach((frame) => app.capturePng(frame, (rendered) => { captured.push(rendered.frame); assertFrameReadBack(rendered, frame); return new Uint8Array([rendered.frame]) }))
    expect(played).toEqual(scrubbed)
    expect(captured).toEqual(frames)
    expect(played.map((rendered) => app.readBack(rendered))).toEqual(frames)
  })
  it.each([
    ["missing font", { localFonts: [{ family: "Inter", path: "fonts/missing.woff2", ready: false }] }, "LOCAL_FONT_NOT_READY"],
    ["remote font", { localFonts: [{ family: "Inter", path: "https://fonts.example/font.woff2", ready: true }] }, "REMOTE_FONT_URL_REJECTED"],
    ["empty font path", { localFonts: [{ family: "Inter", path: "", ready: true }] }, "LOCAL_FONT_PATH_INVALID"],
    ["non-font local path", { localFonts: [{ family: "Inter", path: "fonts/font.css", ready: true }] }, "LOCAL_FONT_PATH_INVALID"],
  ] as const)("rejects %s", (_name, overrides, token) => expect(() => createRenderApp(input(overrides))).toThrow(new RenderAppError(token)))
  it("can prove readiness with an injected local manifest checker", () => {
    const checked = createRenderApp(input({ fontChecker: (font) => font.path === "fonts/Inter.woff2" }))
    expect(checked.renderFrame(0).fontPaths).toEqual(["fonts/Inter.woff2"])
    expect(() => createRenderApp(input({ fontChecker: () => false }))).toThrow("LOCAL_FONT_NOT_READY")
  })
  it("rejects wrong read-back and flattened image owners", () => {
    const rendered = createRenderApp(input()).renderFrame(70)
    expect(() => assertFrameReadBack({ ...rendered, readBackFrame: 69 }, 70)).toThrow("FRAME_READBACK_MISMATCH")
    expect(rendered.markup).not.toContain("<image")
    expect(rendered.nodes[0]?.tag).toBe("text")
  })
  it("rejects unknown geometry references", () => {
    const badScene = { ...compilation.scene, tracks: [{ ...track, geometryRef: "unknown" }, residualTrack] }
    expect(() => createRenderApp(input({ scene: badScene })).renderFrame(0)).toThrow("UNKNOWN_GEOMETRY_REFERENCE")
  })
  it("does not contain forbidden nondeterministic APIs", async () => {
    const source = await import("node:fs/promises")
    const file = await source.readFile(new URL("./index.ts", import.meta.url), "utf8")
    expect(file).not.toMatch(/Date\.now|new Date|Math\.random|requestAnimationFrame/)
  })
})
