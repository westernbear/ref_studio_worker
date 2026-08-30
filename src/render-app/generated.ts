import { pathToFileURL } from "node:url";
import {
  SPEC_EFFECTS,
  SPEC_TEXT_WEIGHT_AXIS,
  type SpecAsset,
  type SpecTextWeight,
} from "../contracts/index.js";
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

// Same remote-rejection shape as validateLocalFonts above: assetPaths only
// ever holds paths the worker itself wrote to local disk (see
// worker-job-handler.ts's scene-assets download loop and
// gen-render-delivery.ts's assetPaths parameter), so this should never
// trip in production -- it is the same defence-in-depth as
// validateSceneSpec's EXTERNAL_URL rule, applied one layer closer to the
// markup this module actually emits.
function validateAssetPaths(assetPaths: ReadonlyMap<string, string>): void {
  for (const path of assetPaths.values())
    if (/^(https?:)?\/\//.test(path))
      throw new GeneratedRenderAppError("REMOTE_ASSET_PATH_REJECTED");
}

// Ruling 2, round 3: SPEC_EFFECTS is the allowlist of effects a generated
// scene may request. Round 1 (`blur`, `glow` as SVG filter primitives) and
// round 2 (`drop-shadow` as feDropShadow) both compiled to raster <filter>
// operations and both were dropped -- see SPEC_EFFECTS's own comment in
// packages/contracts/src/scene-spec.ts for why each failed to be
// bit-reproducible across independent Chromium launches (the gate is
// gen-render-delivery.determinism.test.ts). This round tried the same two
// effect *names* as geometry instead: extra copies of the element,
// composited with nothing but fill/opacity/translate -- no <filter>
// element, no CSS filter, anywhere below.
//
// Geometry was not a uniform win, though -- see
// gen-render-delivery.determinism.test.ts's own comment for the full run
// log. `drop-shadow` (one offset, unscaled, darkened copy) held clean
// across every trial, including under the concurrent CPU load of the full
// test suite. `glow` (a second copy scaled up for falloff) did not: even
// after every coordinate was snapped to a whole pixel and the design was
// cut down to a single layer, it still failed intermittently once the
// gate was run under that same concurrent load -- the scaling itself
// (not the stacking, not the sub-pixel edges) is where a geometry copy
// still touches anti-aliased rasterisation, and that is exactly where
// blur and drop-shadow-as-filters failed too. `glow` is dropped a second
// time; only `drop-shadow` survives as geometry.
const KNOWN_EFFECTS: ReadonlySet<string> = new Set(SPEC_EFFECTS);

// A "color" asset's ref is its own value (I5/item 3): it never resolves to
// a file, so wherever an element wants a colour -- a text fill, a shape's
// fill -- and names one of these by assetRef, that ref is used directly.
const colorFill = (asset: SpecAsset | undefined): string | undefined =>
  asset?.kind === "color" ? asset.ref : undefined;

// A named weight reaches the page as the axis number it stands for, as an
// SVG presentation attribute -- the capture page defaults text to 700 only
// for text carrying no font-weight of its own (capture/browser.ts), so an
// attribute is precisely what overrides it. Absent stays absent: no
// attribute, page default, byte-identical to how the scene rendered before
// this field existed.
const weightAttribute = (weight: SpecTextWeight | undefined): string =>
  weight === undefined ? "" : ` font-weight="${SPEC_TEXT_WEIGHT_AXIS[weight]}"`;

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const transformAttribute = (
  transform: FramePlan["draws"][number]["transform"],
): string =>
  transform === undefined ? "" : ` transform="matrix(${transform.join(" ")})"`;

// A drop shadow is one offset, darkened copy drawn beneath the element. The
// offset is fixed canvas pixels, not proportional to the element's box, so
// the implied light angle reads the same regardless of how big the
// element is.
const DROP_SHADOW_OFFSET_X = 10;
const DROP_SHADOW_OFFSET_Y = 14;
const DROP_SHADOW_OPACITY_FACTOR = 0.4;

// Rounds every coordinate to a whole canvas pixel. Not cosmetic: measured
// against the determinism gate, this is what separated a reliable effect
// copy from an intermittently non-bit-reproducible one (see KNOWN_EFFECTS's
// comment above -- this alone was not enough to save `glow`, but every
// surviving effect copy still gets it, defensively, since nothing
// guarantees the *element's own* box, already carrying that element's
// animated scale/x/y, reaches this module pixel-aligned).
const translateBox = (box: Box, dx: number, dy: number): Box => ({
  x: Math.round(box.x + dx),
  y: Math.round(box.y + dy),
  width: Math.round(box.width),
  height: Math.round(box.height),
});

// One effect-layer copy: a plain <text> (when the element it shadows
// carries text content) or a plain <rect> otherwise, at its own box and
// opacity, in the given colour. Its own data-element-id (suffixed, still
// escaped) keeps it distinct from the element it sits beneath. Never an
// <image> copy -- see effectLayersMarkup below for why image-kind elements
// skip effects entirely.
const effectLayerMarkup = (
  elementId: string,
  suffix: string,
  box: Box,
  opacity: number,
  color: string,
  content: string | undefined,
  weight: SpecTextWeight | undefined,
  transform: FramePlan["draws"][number]["transform"],
): string => {
  const id = `${escapeXml(elementId)}__${suffix}`;
  const attributes = `data-element-id="${id}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" opacity="${opacity}"${transformAttribute(transform)}`;
  // The shadow copy takes the element's own weight: a copy drawn at the
  // page default under text set in another weight would sit at different
  // glyph widths and read as a second, misaligned line rather than a
  // shadow.
  if (content !== undefined)
    return `<text ${attributes} fill="${escapeXml(color)}" font-size="${Math.max(8, Math.round(box.height * 0.8))}"${weightAttribute(weight)}>${escapeXml(content)}</text>`;
  return `<rect ${attributes} fill="${escapeXml(color)}" />`;
};

// Draws the drop-shadow copy this element's (allowlist-filtered) effects
// ask for, beneath where the element itself will be drawn. Image-kind
// elements are skipped: a shadow behind a photo would need a tint or
// silhouette this module has no geometry for, so (like an effect name
// outside the allowlist) it is a no-op there.
const effectLayersMarkup = (
  draw: FramePlan["draws"][number],
  isImage: boolean,
  shadowColor: string,
): string => {
  if (isImage) return "";
  const known = draw.effects.filter((effect) => KNOWN_EFFECTS.has(effect));
  if (!known.includes("drop-shadow")) return "";
  return effectLayerMarkup(
    draw.elementId,
    "effect-drop-shadow",
    translateBox(draw.box, DROP_SHADOW_OFFSET_X, DROP_SHADOW_OFFSET_Y),
    draw.opacity * DROP_SHADOW_OPACITY_FACTOR,
    shadowColor,
    draw.content,
    draw.weight,
    draw.transform,
  );
};

const drawMarkup = (
  draw: FramePlan["draws"][number],
  palette: SpecCompilation["palette"],
  assetsById: ReadonlyMap<string, SpecAsset>,
  assetPaths: ReadonlyMap<string, string>,
): string => {
  const assetAttribute =
    draw.assetRef !== undefined
      ? ` data-asset-ref="${escapeXml(draw.assetRef)}"`
      : "";
  const attributes =
    `data-element-id="${escapeXml(draw.elementId)}"${assetAttribute} ` +
    `x="${draw.box.x}" y="${draw.box.y}" width="${draw.box.width}" height="${draw.box.height}" opacity="${draw.opacity}"${transformAttribute(draw.transform)}`;
  const asset =
    draw.assetRef !== undefined ? assetsById.get(draw.assetRef) : undefined;
  if (draw.kind === "video")
    throw new GeneratedRenderAppError("VIDEO_RENDER_UNSUPPORTED");
  // Item 1, the whole point of the material provider: an element whose
  // assetRef resolves to an image asset draws that image at its box,
  // stretched to fill it exactly (preserveAspectRatio="none" -- the box,
  // already carrying the element's animated scale from spec-compile.ts,
  // is authoritative over the source image's own aspect ratio) and
  // respecting the element's animated opacity via the shared `opacity`
  // attribute above. Default (smooth/bilinear) scaling was measured
  // deterministic across 8 independent Chromium launches with a
  // deliberately awkward, non-integer upscale of a noisy fixture image
  // (gen-render-delivery.determinism.test.ts exercises this for real);
  // image-rendering:pixelated was tried too and was equally stable, but
  // was dropped in favour of the sharper default -- a product photo
  // scaled with nearest-neighbour looks blocky for no reproducibility
  // benefit once smooth scaling is already proven stable.
  if (asset?.kind === "image") {
    const path = assetPaths.get(asset.assetId);
    if (path === undefined)
      throw new GeneratedRenderAppError("ASSET_PATH_UNRESOLVED");
    const href = escapeXml(pathToFileURL(path).href);
    return `<image ${attributes} href="${href}" preserveAspectRatio="none" />`;
  }
  if (draw.content !== undefined) {
    // Item 2: text must use the palette rather than defaulting -- an
    // explicit colour asset wins if the element names one, otherwise the
    // scene's hero colour, never the capture page's stylesheet default.
    const fill = colorFill(asset) ?? palette.hero;
    const effects = effectLayersMarkup(draw, false, palette.background);
    return `${effects}<text ${attributes} fill="${escapeXml(fill)}" font-size="${Math.max(8, Math.round(draw.box.height * 0.8))}"${weightAttribute(draw.weight)}>${escapeXml(draw.content)}</text>`;
  }
  // A shape with no colour-asset override used to render as an unfilled
  // (invisible) rect -- the same class of bug as the white background that
  // I5 fixed for the canvas ground (see backgroundMarkup below): a scene
  // that asks for a shape must get a visible one. "cool" is the default
  // rather than "hero" (already text's default, above) or "background"
  // (already the ground's own colour) so a bare shape reads as a distinct,
  // secondary tone rather than restating either of those.
  const fill = colorFill(asset) ?? palette.cool;
  const effects = effectLayersMarkup(draw, false, palette.background);
  return `${effects}<rect ${attributes} fill="${escapeXml(fill)}" />`;
};

// Full-canvas ground, painted before anything else so a scene that asked
// for pure black does not fall through to the capture page's default
// background (item 2). stroke="none" and style="rx:0" defeat the shared
// page's unconditional `#scene rect { rx: 28 }` / default-stroke rules
// (capture/browser.ts, off-limits to edit) from within markup we do
// control: an inline style attribute always wins over an external
// stylesheet rule, and a plain stroke="none" presentation attribute
// already satisfies that stylesheet's `:where(:not([stroke]))` opt-out.
const backgroundMarkup = (
  canvas: SpecCompilation["canvas"],
  palette: SpecCompilation["palette"],
): string =>
  `<rect data-element-id="scene-background" x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="${escapeXml(palette.background)}" stroke="none" style="rx:0" />`;

export function createGeneratedRenderApp(
  compilation: SpecCompilation,
  localFonts: readonly LocalFont[],
  assets: readonly SpecAsset[] = [],
  assetPaths: ReadonlyMap<string, string> = new Map(),
): { readonly renderFrame: (frame: number) => RenderedFrame } {
  validateLocalFonts(localFonts);
  validateAssetPaths(assetPaths);
  const assetsById = new Map(
    assets.map((asset) => [asset.assetId, asset] as const),
  );
  const framesByIndex = new Map(
    compilation.frames.map((plan) => [plan.frame, plan] as const),
  );
  const renderFrame = (frame: number): RenderedFrame => {
    if (!Number.isInteger(frame) || frame < 0)
      throw new GeneratedRenderAppError("INVALID_FRAME");
    const plan = framesByIndex.get(frame);
    const nodes = (plan?.draws ?? [])
      .map((draw) =>
        drawMarkup(draw, compilation.palette, assetsById, assetPaths),
      )
      .join("");
    return {
      frame,
      markup: `<svg data-frame="${frame}" role="img"><g>${backgroundMarkup(compilation.canvas, compilation.palette)}${nodes}</g></svg>`,
    };
  };
  return { renderFrame };
}
