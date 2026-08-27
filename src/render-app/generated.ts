import { SPEC_EFFECTS, type SpecAsset } from "../contracts/index.js";
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
// SVG filter primitives a generated scene may request. `blur`, `glow`, and
// (once this batch painted a real background under a palette-aware fill)
// `drop-shadow` were all tried and dropped -- see SPEC_EFFECTS's own
// comment in packages/contracts/src/scene-spec.ts for why each one failed
// to be bit-reproducible across independent Chromium launches (the gate is
// gen-render-delivery.determinism.test.ts). SPEC_EFFECTS is currently
// empty, so there is nothing left to define a <filter> for -- but the
// allowlist-driven wiring below stays in place for whenever an effect
// passes that gate.
const FILTER_DEFS = "";

const KNOWN_EFFECTS: ReadonlySet<string> = new Set(SPEC_EFFECTS);

const filterAttribute = (effects: readonly string[]): string => {
  const known = effects.filter((effect) => KNOWN_EFFECTS.has(effect));
  if (known.length === 0) return "";
  return ` filter="${known.map((effect) => `url(#effect-${effect})`).join(" ")}"`;
};

// A "color" asset's ref is its own value (I5/item 3): it never resolves to
// a file, so wherever an element wants a colour -- a text fill, a shape's
// fill -- and names one of these by assetRef, that ref is used directly.
const colorFill = (
  assetRef: string | undefined,
  assetsById: ReadonlyMap<string, SpecAsset>,
): string | undefined => {
  if (assetRef === undefined) return undefined;
  const asset = assetsById.get(assetRef);
  return asset?.kind === "color" ? asset.ref : undefined;
};

const drawMarkup = (
  draw: FramePlan["draws"][number],
  palette: SpecCompilation["palette"],
  assetsById: ReadonlyMap<string, SpecAsset>,
): string => {
  const assetAttribute =
    draw.assetRef !== undefined
      ? ` data-asset-ref="${escapeXml(draw.assetRef)}"`
      : "";
  const attributes =
    `data-element-id="${escapeXml(draw.elementId)}"${assetAttribute}${filterAttribute(draw.effects)} ` +
    `x="${draw.box.x}" y="${draw.box.y}" width="${draw.box.width}" height="${draw.box.height}" opacity="${draw.opacity}"`;
  // ponytail: video-kind assets are out of scope for this batch (only
  // images resolve to real pixels -- see the module comment above the
  // image branch, once one exists). A video-referencing element falls
  // through to the same undrawn placeholder a bare shape gets.
  if (draw.content !== undefined) {
    // Item 2: text must use the palette rather than defaulting -- an
    // explicit colour asset wins if the element names one, otherwise the
    // scene's hero colour, never the capture page's stylesheet default.
    const fill = colorFill(draw.assetRef, assetsById) ?? palette.hero;
    return `<text ${attributes} fill="${escapeXml(fill)}" font-size="${Math.max(8, Math.round(draw.box.height * 0.8))}">${escapeXml(draw.content)}</text>`;
  }
  const fill = colorFill(draw.assetRef, assetsById);
  const fillAttribute = fill !== undefined ? ` fill="${escapeXml(fill)}"` : "";
  return `<rect ${attributes}${fillAttribute} />`;
};

// Full-canvas ground, painted before anything else so a scene that asked
// for pure black does not fall through to the capture page's default
// background (item 2). stroke="none" and style="rx:0" defeat the shared
// page's unconditional `#scene rect { rx: 28 }` / default-stroke rules
// (capture/browser.ts, off-limits to edit) from within markup we do
// control: an inline style attribute always wins over an external
// stylesheet rule, and a plain stroke="none" presentation attribute
// already satisfies that stylesheet's `:where(:not([stroke]))` opt-out.
const backgroundMarkup = (canvas: SpecCompilation["canvas"], palette: SpecCompilation["palette"]): string =>
  `<rect data-element-id="scene-background" x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="${escapeXml(palette.background)}" stroke="none" style="rx:0" />`;

export function createGeneratedRenderApp(
  compilation: SpecCompilation,
  localFonts: readonly LocalFont[],
  assets: readonly SpecAsset[] = [],
): { readonly renderFrame: (frame: number) => RenderedFrame } {
  validateLocalFonts(localFonts);
  const assetsById = new Map(assets.map((asset) => [asset.assetId, asset] as const));
  const framesByIndex = new Map(
    compilation.frames.map((plan) => [plan.frame, plan] as const),
  );
  const renderFrame = (frame: number): RenderedFrame => {
    if (!Number.isInteger(frame) || frame < 0)
      throw new GeneratedRenderAppError("INVALID_FRAME");
    const plan = framesByIndex.get(frame);
    const nodes = (plan?.draws ?? [])
      .map((draw) => drawMarkup(draw, compilation.palette, assetsById))
      .join("");
    return {
      frame,
      markup: `<svg data-frame="${frame}" role="img">${FILTER_DEFS}<g>${backgroundMarkup(compilation.canvas, compilation.palette)}${nodes}</g></svg>`,
    };
  };
  return { renderFrame };
}
