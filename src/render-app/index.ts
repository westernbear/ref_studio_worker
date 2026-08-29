import type {
  Asset,
  BrowserPassSpec,
  FrameBounds,
  Owner,
  SceneIR,
  Track,
} from "../scene/compile.js";

export type LocalFont = {
  readonly family: string;
  readonly path: string;
};
export type RenderInput = {
  readonly browserPassSpec: BrowserPassSpec;
  readonly scene: SceneIR;
  readonly owners: readonly Owner[];
  // Carries the measured palette. Without it the only colour available is the
  // capture page's near-black placeholder fill, so every owner renders as an
  // invisible rectangle no matter how well it was detected.
  readonly assets: readonly Asset[];
  readonly localFonts: readonly LocalFont[];
};
export type RenderedFrame = {
  readonly frame: number;
  readonly markup: string;
};

export class RenderAppError extends Error {
  readonly token: string;
  constructor(token: string) {
    super(token);
    this.name = "RenderAppError";
    this.token = token;
  }
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const frameValue = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const lifecycleFrame = (
  track: Track,
  name: "enter" | "exit",
): number | undefined => {
  const lifecycle = track.lifecycle[name];
  if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle))
    return undefined;
  return frameValue(lifecycle["start"]);
};

function boundsAt(scene: SceneIR, track: Track, frame: number): FrameBounds {
  const geometry = scene.geometry[track.geometryRef];
  if (!geometry) throw new RenderAppError("UNKNOWN_GEOMETRY_REFERENCE");
  const exact = geometry.boundsPerFrame.find(
    (bounds) => bounds.frame === frame,
  );
  if (exact) return exact;
  const candidates = geometry.boundsPerFrame.filter(
    (bounds) => bounds.frame <= frame,
  );
  const before = candidates[candidates.length - 1];
  const after = geometry.boundsPerFrame.find((bounds) => bounds.frame > frame);
  const fallback = before ?? after;
  if (!fallback) throw new RenderAppError("MISSING_MEASURED_GEOMETRY");
  if (!before || !after) return fallback;
  const fraction = (frame - before.frame) / (after.frame - before.frame);
  const interpolate = (start: number, end: number): number =>
    start + (end - start) * fraction;
  return {
    frame,
    x: interpolate(before.x, after.x),
    y: interpolate(before.y, after.y),
    width: interpolate(before.width, after.width),
    height: interpolate(before.height, after.height),
  };
}

const effectAt = (value: unknown, frame: number): number => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return 0;
  const samples = Reflect.get(value, "samples");
  if (!Array.isArray(samples)) return 0;
  const measured = samples
    .map((sample) => {
      if (
        typeof sample !== "object" ||
        sample === null ||
        Array.isArray(sample)
      )
        return null;
      const sampleFrame = Reflect.get(sample, "frame");
      const sampleValue = Reflect.get(sample, "value");
      return Number.isFinite(sampleFrame) && Number.isFinite(sampleValue)
        ? { frame: Number(sampleFrame), value: Number(sampleValue) }
        : null;
    })
    .filter(
      (sample): sample is { frame: number; value: number } => sample !== null,
    )
    .sort((left, right) => left.frame - right.frame);
  if (measured.length === 0) return 0;
  const before = measured.filter((sample) => sample.frame <= frame).at(-1);
  const after = measured.find((sample) => sample.frame >= frame);
  const fallback = before ?? after;
  if (!fallback) return 0;
  if (!before || !after || before.frame === after.frame)
    return Math.min(1, Math.max(0, fallback.value));
  const fraction = (frame - before.frame) / (after.frame - before.frame);
  return Math.min(
    1,
    Math.max(0, before.value + (after.value - before.value) * fraction),
  );
};

function visible(track: Track, frame: number): boolean {
  const enter = lifecycleFrame(track, "enter") ?? 0;
  const exit = lifecycleFrame(track, "exit");
  return frame >= enter && (exit === undefined || frame < exit);
}

function validateInput(input: RenderInput): void {
  if (
    input.browserPassSpec.schema !== "browser-pass-spec-v1" ||
    input.scene.schema !== "scene-ir-v1"
  )
    throw new RenderAppError("INVALID_RENDER_SPEC");
  if (
    input.browserPassSpec.sceneVersionId !== input.scene.versionId ||
    input.browserPassSpec.renderDigest !== input.scene.digest
  )
    throw new RenderAppError("RENDER_DIGEST_MISMATCH");
  for (const font of input.localFonts) {
    if (font.family.trim().length === 0 || font.path.trim().length === 0)
      throw new RenderAppError("LOCAL_FONT_PATH_INVALID");
    if (/^(https?:)?\/\//.test(font.path))
      throw new RenderAppError("REMOTE_FONT_URL_REJECTED");
    if (!/\.(woff2?|ttf|otf)$/i.test(font.path) || /[?#]/.test(font.path))
      throw new RenderAppError("LOCAL_FONT_PATH_INVALID");
  }
  const owners = new Set(input.owners.map((owner) => owner.ownerId));
  for (const track of input.scene.tracks)
    if (!owners.has(track.owner)) throw new RenderAppError("OWNER_MISMATCH");
  const domOwners = new Set(
    input.browserPassSpec.passList
      .filter((pass) => pass.kind === "DOM/SVG")
      .flatMap((pass) => pass.owner.split(",")),
  );
  for (const track of input.scene.tracks)
    if (!domOwners.has(track.owner))
      throw new RenderAppError("DOM_PASS_MISSING");
}

const orderedTracks = (input: RenderInput): readonly Track[] => {
  const layers = new Map(
    input.browserPassSpec.layerOrder.map((layer, index) => [layer, index]),
  );
  const ownerLayers = new Map<string, number>();
  for (const pass of input.browserPassSpec.passList) {
    if (pass.kind !== "DOM/SVG") continue;
    const layer = layers.get(pass.writes);
    if (layer === undefined) throw new RenderAppError("PASS_ORDER_MISMATCH");
    for (const owner of pass.owner.split(",")) ownerLayers.set(owner, layer);
  }
  return input.scene.tracks
    .map((track, index) => ({ track, index }))
    .sort(
      (left, right) =>
        (ownerLayers.get(left.track.owner) ?? Number.MAX_SAFE_INTEGER) -
          (ownerLayers.get(right.track.owner) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ track }) => track);
};

const HEX = /^#[0-9a-f]{6}$/iu;
// The compiler measures a dark-to-light ramp per owner. Take the light end for
// text (it has to read against the scene) and the middle for a surface (its
// body colour). Anything unmeasured stays null so the stylesheet still wins.
// The stops run dark to light. A card's body really is the middle one -- these
// surfaces are dark and lit from their own edge -- and the lightest stop is
// that edge: measured across the reference, the outer band of a card sits two
// to three times brighter than its centre and carries the warm colour the card
// reads by. Sending the lightest stop to `ink` alone meant it only ever reached
// text, and every card was stroked with the stylesheet's fixed white instead.
const palette = (
  asset: Asset,
): Readonly<{ body: string | null; edge: string | null }> => {
  const stops = asset["palette"];
  const hex = Array.isArray(stops)
    ? stops.filter(
        (stop): stop is string => typeof stop === "string" && HEX.test(stop),
      )
    : [];
  if (hex.length === 0) return { body: null, edge: null };
  return {
    body: hex[Math.floor(hex.length / 2)] ?? null,
    edge: hex[hex.length - 1] ?? null,
  };
};

export function createRenderApp(input: RenderInput): {
  readonly renderFrame: (frame: number) => RenderedFrame;
} {
  validateInput(input);
  const ownerMap = new Map(input.owners.map((owner) => [owner.ownerId, owner]));
  const paletteMap = new Map(
    input.assets.map((asset) => [asset.owner, palette(asset)]),
  );
  const tracks = orderedTracks(input);
  const renderFrame = (frame: number): RenderedFrame => {
    if (!Number.isInteger(frame) || frame < 0)
      throw new RenderAppError("INVALID_FRAME");
    const markupNodes: string[] = [];
    for (const track of tracks) {
      if (!visible(track, frame)) continue;
      const owner = ownerMap.get(track.owner);
      if (!owner) throw new RenderAppError("OWNER_MISMATCH");
      const bounds = boundsAt(input.scene, track, frame);
      const content = owner.content ?? null;
      const tag =
        owner.kind === "text-word" || owner.kind === "subtitle"
          ? "text"
          : "rect";
      const ownerEffects = input.scene.effects[owner.ownerId];
      const effects = {
        bloom: effectAt(ownerEffects?.["bloom"], frame),
        defocus: effectAt(ownerEffects?.["defocus"], frame),
        rim: effectAt(ownerEffects?.["rim"], frame),
      };
      const colors = paletteMap.get(owner.ownerId);
      const measuredFill = tag === "text" ? colors?.edge : colors?.body;
      const fill = measuredFill ? ` fill="${escapeXml(measuredFill)}"` : "";
      const stroke =
        tag === "rect" && colors?.edge
          ? ` stroke="${escapeXml(colors.edge)}"`
          : "";
      const attributes = `data-owner-id="${escapeXml(owner.ownerId)}" data-editable="${owner.editable}" data-bloom="${effects.bloom}" data-defocus="${effects.defocus}" data-rim="${effects.rim}"${fill}${stroke} x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}"`;
      markupNodes.push(
        tag === "text"
          ? `<text ${attributes} font-size="${Math.max(8, Math.round(bounds.height * 0.92))}" textLength="${bounds.width}" lengthAdjust="spacingAndGlyphs">${escapeXml(content ?? "")}</text>`
          : `<rect ${attributes} />`,
      );
    }
    return {
      frame,
      markup: `<svg data-frame="${frame}" role="img"><g data-layer-order="${escapeXml(input.browserPassSpec.layerOrder.join(","))}">${markupNodes.join("")}</g></svg>`,
    };
  };
  return { renderFrame };
}
