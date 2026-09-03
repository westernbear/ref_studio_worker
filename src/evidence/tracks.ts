import { z } from "zod";

export type EvidenceTrackKind =
  | "bbox"
  | "trajectory"
  | "ocr-text"
  | "effect"
  | "audio-anchor";

export type EvidenceTrackFrame = Readonly<{
  frame: number;
  bounds?: readonly [number, number, number, number];
  point?: readonly [number, number];
  confidence: number;
}>;

export type EvidenceTrack = Readonly<{
  ownerId: string;
  kind: EvidenceTrackKind;
  label: string;
  frames: readonly EvidenceTrackFrame[];
}>;

const RecordSchema = z.record(z.string(), z.unknown());
const Finite = z.number().finite();
const FrameBoundsSchema = z.object({
  frame: Finite,
  x: Finite,
  y: Finite,
  width: Finite,
  height: Finite,
});
const ContentWindowSchema = z.object({
  x: Finite,
  y: Finite,
  width: z.number().positive(),
  height: z.number().positive(),
});
const OwnerSchema = z.object({
  ownerId: z.string(),
  confidence: Finite.optional(),
});
const TrackSchema = z.object({
  owner: z.string(),
  geometryRef: z.string(),
  effects: z.unknown().optional(),
});
const OcrCandidateSchema = z.object({
  frame: Finite,
  confidence: Finite,
  text: z.string(),
  bounds: z.array(z.unknown()).length(4),
});
const AudioAnchorSchema = z.object({
  anchorId: z.unknown().optional(),
  frame: Finite,
  owner: z.unknown().optional(),
  role: z.unknown().optional(),
  confidence: Finite,
});

const asRecord = (value: unknown): Record<string, unknown> | null => {
  const parsed = RecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

type FrameBounds = z.infer<typeof FrameBoundsSchema>;
const readFrameBounds = (value: unknown): FrameBounds | null => {
  const parsed = FrameBoundsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
// The reference clip may be letterboxed, and the compiler analyses only the
// content inside it. sceneInput geometry is therefore expressed in
// render-canvas coordinates (1080x1920) derived from that window, while
// observed.ocr bounds stay in analysis pixels relative to the window's
// origin. The evidence overlay draws onto the untouched reference video, so
// both have to come back to that video's own pixels first -- without this
// every box lands somewhere else, most visibly out in the black bars.
const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;

type ContentWindow = z.infer<typeof ContentWindowSchema>;

const readContentWindow = (
  bundle: Record<string, unknown>,
): ContentWindow | null => {
  const observed = asRecord(bundle["observed"]);
  const parsed = ContentWindowSchema.safeParse(observed?.["contentWindow"]);
  return parsed.success ? parsed.data : null;
};

const canvasToFrame = (
  bounds: FrameBounds,
  window: ContentWindow | null,
): FrameBounds => {
  if (!window) return bounds;
  const scale = Math.min(
    CANVAS_WIDTH / window.width,
    CANVAS_HEIGHT / window.height,
  );
  if (!(scale > 0)) return bounds;
  const offsetX = (CANVAS_WIDTH - window.width * scale) / 2;
  const offsetY = (CANVAS_HEIGHT - window.height * scale) / 2;
  return {
    frame: bounds.frame,
    x: Math.round(window.x + (bounds.x - offsetX) / scale),
    y: Math.round(window.y + (bounds.y - offsetY) / scale),
    width: Math.max(1, Math.round(bounds.width / scale)),
    height: Math.max(1, Math.round(bounds.height / scale)),
  };
};

const analysisToFrame = (
  bounds: FrameBounds,
  window: ContentWindow | null,
): FrameBounds =>
  window
    ? { ...bounds, x: bounds.x + window.x, y: bounds.y + window.y }
    : bounds;

const readGeometryTrack = (
  bundle: Record<string, unknown>,
  geometryRef: string,
): readonly FrameBounds[] => {
  const sceneInput = asRecord(bundle["sceneInput"]);
  const geometry = asRecord(sceneInput?.["geometry"]);
  const entry = asRecord(geometry?.[geometryRef]);
  const boundsPerFrame = entry?.["boundsPerFrame"];
  if (!Array.isArray(boundsPerFrame)) return [];
  const window = readContentWindow(bundle);
  return boundsPerFrame
    .map(readFrameBounds)
    .filter((item): item is FrameBounds => item !== null)
    .map((item) => canvasToFrame(item, window));
};

// ponytail: owner confidence is read once per track (not per frame) --
// the compiled sceneInput doesn't carry per-frame confidence for geometry.
const readOwnerConfidence = (
  bundle: Record<string, unknown>,
  ownerId: string,
): number => {
  const sceneInput = asRecord(bundle["sceneInput"]);
  const owners = sceneInput?.["owners"];
  if (!Array.isArray(owners)) return 1;
  const owner = owners.find((item) => {
    const parsed = OwnerSchema.safeParse(item);
    return parsed.success && parsed.data.ownerId === ownerId;
  });
  const parsed = OwnerSchema.safeParse(owner);
  return parsed.success && parsed.data.confidence !== undefined
    ? parsed.data.confidence
    : 1;
};

const sceneTracks = (
  bundle: Record<string, unknown>,
): z.infer<typeof TrackSchema>[] => {
  const sceneInput = asRecord(bundle["sceneInput"]);
  const tracks = sceneInput?.["tracks"];
  if (!Array.isArray(tracks)) return [];
  return tracks.flatMap((track) => {
    const parsed = TrackSchema.safeParse(track);
    return parsed.success ? [parsed.data] : [];
  });
};

const bboxAndTrajectoryTracks = (
  bundle: Record<string, unknown>,
): EvidenceTrack[] => {
  const result: EvidenceTrack[] = [];
  for (const track of sceneTracks(bundle)) {
    const bounds = readGeometryTrack(bundle, track.geometryRef);
    if (bounds.length === 0) continue;
    const confidence = readOwnerConfidence(bundle, track.owner);
    result.push({
      ownerId: track.owner,
      kind: "bbox",
      label: track.owner,
      frames: bounds.map((item) => ({
        frame: item.frame,
        bounds: [item.x, item.y, item.width, item.height],
        confidence,
      })),
    });
    result.push({
      ownerId: track.owner,
      kind: "trajectory",
      label: track.owner,
      frames: bounds.map((item) => ({
        frame: item.frame,
        point: [item.x + item.width / 2, item.y + item.height / 2],
        confidence,
      })),
    });
  }
  return result;
};

const effectTracks = (bundle: Record<string, unknown>): EvidenceTrack[] => {
  const result: EvidenceTrack[] = [];
  for (const track of sceneTracks(bundle)) {
    const effects = z.array(z.string()).safeParse(track.effects);
    if (!effects.success || effects.data.length === 0) continue;
    const bounds = readGeometryTrack(bundle, track.geometryRef);
    if (bounds.length === 0) continue;
    result.push({
      ownerId: track.owner,
      kind: "effect",
      label: effects.data.join("+"),
      frames: bounds.map((item) => ({
        frame: item.frame,
        bounds: [item.x, item.y, item.width, item.height],
        confidence: readOwnerConfidence(bundle, track.owner),
      })),
    });
  }
  return result;
};

// ponytail: one track per unique OCR text string; pipeline.py already
// dedups/tracks candidates upstream, so this is a light regrouping, not a
// re-implementation of its tracking logic.
const ocrTextTracks = (bundle: Record<string, unknown>): EvidenceTrack[] => {
  const observed = asRecord(bundle["observed"]);
  const ocr = asRecord(observed?.["ocr"]);
  const candidates = ocr?.["candidates"];
  if (!Array.isArray(candidates)) return [];
  const window = readContentWindow(bundle);
  const byText = new Map<string, EvidenceTrackFrame[]>();
  for (const candidate of candidates) {
    const parsed = OcrCandidateSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { frame, confidence, text, bounds } = parsed.data;
    const box = readFrameBounds({
      frame,
      x: bounds[0],
      y: bounds[1],
      width: bounds[2],
      height: bounds[3],
    });
    if (!box) continue;
    const placed = analysisToFrame(box, window);
    const frames = byText.get(text) ?? [];
    frames.push({
      frame,
      bounds: [placed.x, placed.y, placed.width, placed.height],
      confidence,
    });
    byText.set(text, frames);
  }
  return [...byText.entries()].map(([text, frames], index) => ({
    ownerId: `ocr-text-${index}`,
    kind: "ocr-text" as const,
    label: text,
    frames,
  }));
};

const audioAnchorTracks = (
  bundle: Record<string, unknown>,
): EvidenceTrack[] => {
  const sceneInput = asRecord(bundle["sceneInput"]);
  const audio = asRecord(sceneInput?.["audio"]);
  const anchors = audio?.["anchors"];
  if (!Array.isArray(anchors)) return [];
  return anchors
    .map((anchor, index): EvidenceTrack | null => {
      const parsed = AudioAnchorSchema.safeParse(anchor);
      if (!parsed.success) return null;
      const { anchorId, frame, owner, role, confidence } = parsed.data;
      return {
        ownerId: typeof owner === "string" ? owner : `audio-anchor-${index}`,
        kind: "audio-anchor",
        label:
          typeof role === "string"
            ? role
            : typeof anchorId === "string"
              ? anchorId
              : "cue",
        frames: [{ frame, confidence }],
      };
    })
    .filter((item): item is EvidenceTrack => item !== null);
};

export const projectEvidenceTracks = (
  bundle: Record<string, unknown>,
): EvidenceTrack[] => [
  ...bboxAndTrajectoryTracks(bundle),
  ...ocrTextTracks(bundle),
  ...effectTracks(bundle),
  ...audioAnchorTracks(bundle),
];
