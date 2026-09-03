import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex, type SceneSpec } from "./contracts/index.js";
import { fileSha256 } from "./file-sha256.js";
import {
  buildBeatDependencies,
  type BeatDependency,
} from "./partial-render-dependencies.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const CachedFrameSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    sha256: z.string().regex(DIGEST),
  })
  .strict();
const CachedBeatSchema = z
  .object({
    beatId: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().positive(),
    beatDigest: z.string().regex(DIGEST),
    transitionDigest: z.string().regex(DIGEST),
    dependencyDigest: z.string().regex(DIGEST),
    frames: z.array(CachedFrameSchema).min(1),
  })
  .strict();
const ManifestSchema = z
  .object({
    schema: z.literal("rvs.partial-render-cache.v1"),
    cacheKey: z.string().regex(DIGEST),
    sceneDigest: z.string().regex(DIGEST),
    runtimeFingerprint: z.string().regex(DIGEST),
    compilerVersion: z.string().min(1),
    globalAssetDigest: z.string().regex(DIGEST),
    beats: z.array(CachedBeatSchema).min(1),
  })
  .strict();

export type CachedManifest = z.infer<typeof ManifestSchema>;
export type PartialRenderPlan = Readonly<{
  mode: "full" | "partial";
  reason: string;
  cacheDirectory?: string;
  cacheKey: string;
  sceneDigest: string;
  runtimeFingerprint: string;
  compilerVersion: string;
  globalAssetDigest: string;
  beats: readonly BeatDependency[];
  framesToRender: readonly number[];
  reusedFrames: ReadonlyMap<number, Readonly<{ path: string; sha256: string }>>;
  renderedBeatIds: readonly string[];
  reusedBeatIds: readonly string[];
}>;

type PlanBase = Omit<
  PartialRenderPlan,
  | "mode"
  | "reason"
  | "framesToRender"
  | "reusedFrames"
  | "renderedBeatIds"
  | "reusedBeatIds"
>;
const fullPlan = (
  base: PlanBase,
  frameCount: number,
  reason: string,
): PartialRenderPlan => ({
  ...base,
  mode: "full",
  reason,
  framesToRender: Array.from({ length: frameCount }, (_, frame) => frame),
  reusedFrames: new Map(),
  renderedBeatIds: base.beats.map((beat) => beat.beatId),
  reusedBeatIds: [],
});

export async function preparePartialRender(
  input: Readonly<{
    spec: SceneSpec;
    assetDigests: ReadonlyMap<string, string>;
    runtimeFingerprint: string;
    compilerVersion: string;
    cacheDirectory?: string;
  }>,
): Promise<PartialRenderPlan> {
  const sceneDigest = sha256Hex(input.spec);
  const dependencySet = buildBeatDependencies(input.spec, input.assetDigests);
  const cacheKey = sha256Hex({
    sceneDigest,
    beats: dependencySet.beats,
    assetHashes: [...input.assetDigests].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    runtimeFingerprint: input.runtimeFingerprint,
    compilerVersion: input.compilerVersion,
  });
  const base: PlanBase = {
    ...(input.cacheDirectory ? { cacheDirectory: input.cacheDirectory } : {}),
    cacheKey,
    sceneDigest,
    runtimeFingerprint: input.runtimeFingerprint,
    compilerVersion: input.compilerVersion,
    ...dependencySet,
  };
  if (!input.cacheDirectory)
    return fullPlan(base, input.spec.canvas.frameCount, "disabled");

  let manifest: CachedManifest;
  try {
    manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(input.cacheDirectory, "manifest.json"), "utf8"),
      ),
    );
  } catch {
    return fullPlan(base, input.spec.canvas.frameCount, "missing-or-invalid");
  }
  if (
    manifest.runtimeFingerprint !== input.runtimeFingerprint ||
    manifest.compilerVersion !== input.compilerVersion ||
    manifest.globalAssetDigest !== dependencySet.globalAssetDigest
  )
    return fullPlan(
      base,
      input.spec.canvas.frameCount,
      "global-dependency-changed",
    );
  if (
    new Set(manifest.beats.map((beat) => beat.beatId)).size !==
    manifest.beats.length
  )
    return fullPlan(base, input.spec.canvas.frameCount, "ambiguous");

  const cached = new Map(manifest.beats.map((beat) => [beat.beatId, beat]));
  const invalid = new Set<number>();
  for (const [index, beat] of dependencySet.beats.entries()) {
    const previous = cached.get(beat.beatId);
    if (
      !previous ||
      previous.startFrame !== beat.startFrame ||
      previous.endFrame !== beat.endFrame ||
      previous.dependencyDigest !== beat.dependencyDigest
    )
      invalid.add(index);
    if (previous && previous.transitionDigest !== beat.transitionDigest)
      for (
        let downstream = index;
        downstream < dependencySet.beats.length;
        downstream++
      )
        invalid.add(downstream);
  }

  const reusedFrames = new Map<
    number,
    Readonly<{ path: string; sha256: string }>
  >();
  let totalBytes = 0;
  try {
    for (const [index, beat] of dependencySet.beats.entries()) {
      if (invalid.has(index)) continue;
      const previous = cached.get(beat.beatId);
      if (
        !previous ||
        previous.frames.length !== beat.endFrame - beat.startFrame
      )
        throw new Error("CACHE_FRAME_SET_INVALID");
      for (const frame of previous.frames) {
        if (frame.frame < beat.startFrame || frame.frame >= beat.endFrame)
          throw new Error("CACHE_FRAME_RANGE_INVALID");
        const path = join(
          input.cacheDirectory,
          "frames",
          `${frame.sha256}.png`,
        );
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > MAX_FRAME_BYTES
        )
          throw new Error("CACHE_FRAME_UNSAFE");
        totalBytes += stat.size;
        if (
          totalBytes > MAX_CACHE_BYTES ||
          (await fileSha256(path)) !== frame.sha256
        )
          throw new Error("CACHE_FRAME_STALE");
        if (reusedFrames.has(frame.frame))
          throw new Error("CACHE_FRAME_AMBIGUOUS");
        reusedFrames.set(frame.frame, { path, sha256: frame.sha256 });
      }
    }
  } catch {
    return fullPlan(base, input.spec.canvas.frameCount, "stale");
  }

  const renderedBeatIds = dependencySet.beats
    .filter((_beat, index) => invalid.has(index))
    .map((beat) => beat.beatId);
  return {
    ...base,
    mode: "partial",
    reason: "verified",
    framesToRender: dependencySet.beats.flatMap((beat, index) =>
      invalid.has(index)
        ? Array.from(
            { length: beat.endFrame - beat.startFrame },
            (_, offset) => beat.startFrame + offset,
          )
        : [],
    ),
    reusedFrames,
    renderedBeatIds,
    reusedBeatIds: dependencySet.beats
      .filter((_beat, index) => !invalid.has(index))
      .map((beat) => beat.beatId),
  };
}
