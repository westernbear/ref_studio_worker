import type { BrowserPassSpec, FrameBounds, Owner, SceneIR, Track } from "../scene/compile.js"

export type LocalFont = { readonly family: string; readonly path: string; readonly ready: boolean }
export type LocalFontChecker = (font: LocalFont) => boolean
export type RenderInput = {
  readonly browserPassSpec: BrowserPassSpec
  readonly scene: SceneIR
  readonly owners: readonly Owner[]
  readonly localFonts: readonly LocalFont[]
  readonly seed: string
  readonly fontChecker?: LocalFontChecker
}
export type RenderNode = {
  readonly ownerId: string
  readonly tag: "text" | "rect" | "g"
  readonly editable: boolean
  readonly bounds: FrameBounds
  readonly content: string | null
}
export type RenderedFrame = {
  readonly frame: number
  readonly readBackFrame: number
  readonly markup: string
  readonly nodes: readonly RenderNode[]
  readonly seed: string
  readonly fontPaths: readonly string[]
}
export type PngCapture = (frame: RenderedFrame) => Uint8Array

export class RenderAppError extends Error {
  readonly token: string
  constructor(token: string) {
    super(token)
    this.name = "RenderAppError"
    this.token = token
  }
}

const escapeXml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const frameValue = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

const lifecycleFrame = (track: Track, name: "enter" | "exit"): number | undefined => {
  const lifecycle = track.lifecycle[name]
  if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return undefined
  return frameValue(lifecycle["start"])
}

function boundsAt(scene: SceneIR, track: Track, frame: number): FrameBounds {
  const geometry = scene.geometry[track.geometryRef]
  if (!geometry) throw new RenderAppError("UNKNOWN_GEOMETRY_REFERENCE")
  const exact = geometry.boundsPerFrame.find((bounds) => bounds.frame === frame)
  if (exact) return exact
  const candidates = geometry.boundsPerFrame.filter((bounds) => bounds.frame <= frame)
  const fallback = candidates[candidates.length - 1] ?? geometry.boundsPerFrame[0]
  if (!fallback) throw new RenderAppError("MISSING_MEASURED_GEOMETRY")
  return fallback
}

function visible(track: Track, frame: number): boolean {
  const enter = lifecycleFrame(track, "enter") ?? 0
  const exit = lifecycleFrame(track, "exit")
  return frame >= enter && (exit === undefined || frame < exit)
}

function validateInput(input: RenderInput): void {
  if (input.seed.length === 0) throw new RenderAppError("MISSING_DETERMINISTIC_SEED")
  if (input.browserPassSpec.schema !== "browser-pass-spec-v1" || input.scene.schema !== "scene-ir-v1") throw new RenderAppError("INVALID_RENDER_SPEC")
  if (input.browserPassSpec.sceneVersionId !== input.scene.versionId || input.browserPassSpec.renderDigest !== input.scene.digest) throw new RenderAppError("RENDER_DIGEST_MISMATCH")
  for (const font of input.localFonts) {
    if (font.family.trim().length === 0 || font.path.trim().length === 0) throw new RenderAppError("LOCAL_FONT_PATH_INVALID")
    if (/^(https?:)?\/\//.test(font.path)) throw new RenderAppError("REMOTE_FONT_URL_REJECTED")
    if (!/\.(woff2?|ttf|otf)$/i.test(font.path) || /[?#]/.test(font.path)) throw new RenderAppError("LOCAL_FONT_PATH_INVALID")
    if (!font.ready || input.fontChecker?.(font) === false) throw new RenderAppError("LOCAL_FONT_NOT_READY")
  }
  const owners = new Set(input.owners.map((owner) => owner.ownerId))
  for (const track of input.scene.tracks) if (!owners.has(track.owner)) throw new RenderAppError("OWNER_MISMATCH")
}

export type PreviewControls = {
  readonly scrub: (frame: number) => RenderedFrame
  readonly playback: (frames: readonly number[]) => readonly RenderedFrame[]
}

export function createRenderApp(input: RenderInput): { readonly renderFrame: (frame: number) => RenderedFrame; readonly preview: PreviewControls; readonly capturePng: (frame: number, capture: PngCapture) => Uint8Array; readonly readBack: (rendered: RenderedFrame) => number } {
  validateInput(input)
  const ownerMap = new Map(input.owners.map((owner) => [owner.ownerId, owner]))
  const renderFrame = (frame: number): RenderedFrame => {
    if (!Number.isInteger(frame) || frame < 0) throw new RenderAppError("INVALID_FRAME")
    const nodes: RenderNode[] = []
    const markupNodes: string[] = []
    for (const track of input.scene.tracks) {
      if (!visible(track, frame)) continue
      const owner = ownerMap.get(track.owner)
      if (!owner) throw new RenderAppError("OWNER_MISMATCH")
      const bounds = boundsAt(input.scene, track, frame)
      const content = owner.content ?? null
      const tag = owner.kind === "product-copy" ? "text" : "rect"
      nodes.push({ ownerId: owner.ownerId, tag, editable: owner.editable, bounds, content })
      const attributes = `data-owner-id="${escapeXml(owner.ownerId)}" data-editable="${owner.editable}" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}"`
      markupNodes.push(tag === "text" ? `<text ${attributes}>${escapeXml(content ?? "")}</text>` : `<rect ${attributes} />`)
    }
    const fontPaths = input.localFonts.map((font) => font.path)
    const markup = `<svg data-frame="${frame}" data-seed="${escapeXml(input.seed)}" data-font-paths="${escapeXml(fontPaths.join(","))}" role="img"><g data-layer-order="${escapeXml(input.browserPassSpec.layerOrder.join(","))}">${markupNodes.join("")}</g></svg>`
    return { frame, readBackFrame: frame, markup, nodes, seed: input.seed, fontPaths }
  }
  const preview: PreviewControls = { scrub: (frame) => renderFrame(frame), playback: (frames) => frames.map(renderFrame) }
  return { renderFrame, preview, capturePng: (frame, capture) => capture(renderFrame(frame)), readBack: (rendered) => rendered.readBackFrame }
}

export function assertFrameReadBack(rendered: RenderedFrame, requestedFrame: number): void {
  if (rendered.frame !== requestedFrame || rendered.readBackFrame !== requestedFrame || !rendered.markup.includes(`data-frame="${requestedFrame}"`)) throw new RenderAppError("FRAME_READBACK_MISMATCH")
}
