import { SPEC_EFFECTS } from "../contracts/index.js";
import type { FramePlan, SpecCompilation } from "../scene/spec-compile.js";
import type { LocalFont, RenderedFrame } from "./index.js";

// Draws a compiled generated scene (Task 2.3's SpecCompilation) one frame at
// a time. Pure string emitter -- no browser API -- mirroring the shape of
// createRenderApp in ./index.ts: a single <svg data-frame="N"> wrapping a
// <g> of nodes, which is what the capture page (capture/browser.ts) expects.
export class GeneratedRenderAppError extends Error {
  readonly token: string;
  constructor(token: string) {
    super(token);
    this.name = "GeneratedRenderAppError";
    this.token = token;
  }
}

// Copied from ./index.ts (escapeXml is not exported there) -- see the
// render-app/index.ts docstring at the top of this file's sibling module.
const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// Local-font-only policy, mirroring render-app/index.ts:139-146. A generated
// scene never sees a browser-facing URL for a font.
function validateLocalFonts(localFonts: readonly LocalFont[]): void {
  for (const font of localFonts) {
    if (font.family.trim().length === 0 || font.path.trim().length === 0)
      throw new GeneratedRenderAppError("NONLOCAL_FONT");
    if (/^(https?:)?\/\//.test(font.path))
      throw new GeneratedRenderAppError("NONLOCAL_FONT");
    if (!/\.(woff2?|ttf|otf)$/i.test(font.path) || /[?#]/.test(font.path))
      throw new GeneratedRenderAppError("NONLOCAL_FONT");
  }
}

// Ruling 2: Phase 2 ships DOM/SVG only, and SPEC_EFFECTS is the allowlist of
// SVG filter primitives a generated scene may request. `blur` and `glow`
// used to be here too (each a feGaussianBlur-based filter def) but were
// dropped from SPEC_EFFECTS -- feGaussianBlur is not bit-reproducible
// across independent Chromium launches (see
// gen-render-delivery.determinism.test.ts) -- so their filter defs are
// dead code and are not emitted. Only what's still on the allowlist gets a
// <filter> def, defined once and referenced per element by id.
const FILTER_DEFS =
  "<defs>" +
  '<filter id="effect-drop-shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="4" dy="6" stdDeviation="4" flood-opacity="0.6" /></filter>' +
  "</defs>";

const KNOWN_EFFECTS: ReadonlySet<string> = new Set(SPEC_EFFECTS);

const filterAttribute = (effects: readonly string[]): string => {
  const known = effects.filter((effect) => KNOWN_EFFECTS.has(effect));
  if (known.length === 0) return "";
  return ` filter="${known.map((effect) => `url(#effect-${effect})`).join(" ")}"`;
};

const drawMarkup = (draw: FramePlan["draws"][number]): string => {
  const assetAttribute =
    draw.assetRef !== undefined
      ? ` data-asset-ref="${escapeXml(draw.assetRef)}"`
      : "";
  const attributes =
    `data-element-id="${escapeXml(draw.elementId)}"${assetAttribute}${filterAttribute(draw.effects)} ` +
    `x="${draw.box.x}" y="${draw.box.y}" width="${draw.box.width}" height="${draw.box.height}" opacity="${draw.opacity}"`;
  // ponytail: this <rect> is a placeholder, not a finished owner draw --
  // it never resolves draw.assetRef to actual image/video pixels, and
  // carries no fill/background from the spec's palette (dropped upstream,
  // see spec-compile.ts's matching comment). An asset-backed element and a
  // bare shape currently render identically: an unfilled rect. Image
  // compositing and palette-aware fills are the next batch's work
  // (whole-branch review finding I5) -- this fallback is deliberately not
  // "done".
  return draw.content !== undefined
    ? `<text ${attributes} font-size="${Math.max(8, Math.round(draw.box.height * 0.8))}">${escapeXml(draw.content)}</text>`
    : `<rect ${attributes} />`;
};

export function createGeneratedRenderApp(
  compilation: SpecCompilation,
  localFonts: readonly LocalFont[],
): { readonly renderFrame: (frame: number) => RenderedFrame } {
  validateLocalFonts(localFonts);
  const framesByIndex = new Map(
    compilation.frames.map((plan) => [plan.frame, plan] as const),
  );
  const renderFrame = (frame: number): RenderedFrame => {
    if (!Number.isInteger(frame) || frame < 0)
      throw new GeneratedRenderAppError("INVALID_FRAME");
    const plan = framesByIndex.get(frame);
    const nodes = (plan?.draws ?? []).map(drawMarkup).join("");
    return {
      frame,
      markup: `<svg data-frame="${frame}" role="img">${FILTER_DEFS}<g>${nodes}</g></svg>`,
    };
  };
  return { renderFrame };
}
