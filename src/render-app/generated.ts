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

// Ruling 2: Phase 2 ships DOM/SVG only. blur/glow/drop-shadow are SVG filter
// primitives, defined once and referenced per element by id.
const FILTER_DEFS =
  "<defs>" +
  '<filter id="effect-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" /></filter>' +
  '<filter id="effect-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="10" result="blurred" /><feMerge><feMergeNode in="blurred" /><feMergeNode in="SourceGraphic" /></feMerge></filter>' +
  '<filter id="effect-drop-shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="4" dy="6" stdDeviation="4" flood-opacity="0.6" /></filter>' +
  "</defs>";

const KNOWN_EFFECTS = new Set(["blur", "glow", "drop-shadow"]);

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
