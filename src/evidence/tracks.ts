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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";

type FrameBounds = Readonly<{
  frame: number;
  x: number;
  y: number;
  width: number;
  height: number;
}>;
const readFrameBounds = (value: unknown): FrameBounds | null => {
  if (!isRecord(value)) return null;
  const { frame, x, y, width, height } = value;
  if (
    !isNumber(frame) ||
    !isNumber(x) ||
    !isNumber(y) ||
    !isNumber(width) ||
    !isNumber(height)
  )
    return null;
  return { frame, x, y, width, height };
};
const readGeometryTrack = (
  bundle: Record<string, unknown>,
  geometryRef: string,
): readonly FrameBounds[] => {
  const sceneInput = bundle["sceneInput"];
  const geometry = isRecord(sceneInput) ? sceneInput["geometry"] : null;
  const entry = isRecord(geometry) ? geometry[geometryRef] : null;
  const boundsPerFrame = isRecord(entry) ? entry["boundsPerFrame"] : null;
  if (!Array.isArray(boundsPerFrame)) return [];
  return boundsPerFrame
    .map(readFrameBounds)
    .filter((item): item is FrameBounds => item !== null);
};

// ponytail: owner confidence is read once per track (not per frame) --
// the compiled sceneInput doesn't carry per-frame confidence for geometry.
const readOwnerConfidence = (
  bundle: Record<string, unknown>,
  ownerId: string,
): number => {
  const sceneInput = bundle["sceneInput"];
  const owners = isRecord(sceneInput) ? sceneInput["owners"] : null;
  if (!Array.isArray(owners)) return 1;
  const owner = owners.find(
    (item) => isRecord(item) && item["ownerId"] === ownerId,
  );
  const confidence = isRecord(owner) ? owner["confidence"] : null;
  return isNumber(confidence) ? confidence : 1;
};

const bboxAndTrajectoryTracks = (
  bundle: Record<string, unknown>,
): EvidenceTrack[] => {
  const sceneInput = bundle["sceneInput"];
  const tracks = isRecord(sceneInput) ? sceneInput["tracks"] : null;
  if (!Array.isArray(tracks)) return [];
  const result: EvidenceTrack[] = [];
  for (const track of tracks) {
    if (!isRecord(track)) continue;
    const owner = track["owner"];
    const geometryRef = track["geometryRef"];
    if (!isString(owner) || !isString(geometryRef)) continue;
    const bounds = readGeometryTrack(bundle, geometryRef);
    if (bounds.length === 0) continue;
    const confidence = readOwnerConfidence(bundle, owner);
    result.push({
      ownerId: owner,
      kind: "bbox",
      label: owner,
      frames: bounds.map((item) => ({
        frame: item.frame,
        bounds: [item.x, item.y, item.width, item.height],
        confidence,
      })),
    });
    result.push({
      ownerId: owner,
      kind: "trajectory",
      label: owner,
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
  const sceneInput = bundle["sceneInput"];
  const tracks = isRecord(sceneInput) ? sceneInput["tracks"] : null;
  if (!Array.isArray(tracks)) return [];
  const result: EvidenceTrack[] = [];
  for (const track of tracks) {
    if (!isRecord(track)) continue;
    const owner = track["owner"];
    const geometryRef = track["geometryRef"];
    const effects = track["effects"];
    if (
      !isString(owner) ||
      !isString(geometryRef) ||
      !Array.isArray(effects) ||
      effects.length === 0 ||
      !effects.every(isString)
    )
      continue;
    const bounds = readGeometryTrack(bundle, geometryRef);
    if (bounds.length === 0) continue;
    result.push({
      ownerId: owner,
      kind: "effect",
      label: effects.join("+"),
      frames: bounds.map((item) => ({
        frame: item.frame,
        bounds: [item.x, item.y, item.width, item.height],
        confidence: readOwnerConfidence(bundle, owner),
      })),
    });
  }
  return result;
};

// ponytail: one track per unique OCR text string; pipeline.py already
// dedups/tracks candidates upstream, so this is a light regrouping, not a
// re-implementation of its tracking logic.
const ocrTextTracks = (bundle: Record<string, unknown>): EvidenceTrack[] => {
  const observed = bundle["observed"];
  const ocr = isRecord(observed) ? observed["ocr"] : null;
  const candidates = isRecord(ocr) ? ocr["candidates"] : null;
  if (!Array.isArray(candidates)) return [];
  const byText = new Map<string, EvidenceTrackFrame[]>();
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const { frame, confidence, text, bounds } = candidate;
    const box = readFrameBounds(
      Array.isArray(bounds) && bounds.length === 4
        ? { frame, x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] }
        : null,
    );
    if (!isNumber(frame) || !isNumber(confidence) || !isString(text) || !box)
      continue;
    const frames = byText.get(text) ?? [];
    frames.push({
      frame,
      bounds: [box.x, box.y, box.width, box.height],
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

const audioAnchorTracks = (bundle: Record<string, unknown>): EvidenceTrack[] => {
  const sceneInput = bundle["sceneInput"];
  const audio = isRecord(sceneInput) ? sceneInput["audio"] : null;
  const anchors = isRecord(audio) ? audio["anchors"] : null;
  if (!Array.isArray(anchors)) return [];
  return anchors
    .map((anchor, index): EvidenceTrack | null => {
      if (!isRecord(anchor)) return null;
      const { anchorId, frame, owner, role, confidence } = anchor;
      if (!isNumber(frame) || !isNumber(confidence)) return null;
      return {
        ownerId: isString(owner) ? owner : `audio-anchor-${index}`,
        kind: "audio-anchor",
        label: isString(role) ? role : (isString(anchorId) ? anchorId : "cue"),
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
