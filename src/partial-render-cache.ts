import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./contracts/index.js";
import { fileSha256 } from "./file-sha256.js";
import {
  preparePartialRender,
  type CachedManifest,
  type PartialRenderPlan,
} from "./partial-render-plan.js";

export { preparePartialRender, type PartialRenderPlan };

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

export async function materializePartialFrames(
  plan: PartialRenderPlan,
  capturedDirectory: string,
  canonicalDirectory: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  await mkdir(canonicalDirectory, { recursive: true });
  const captured = new Map(
    plan.framesToRender.map((frame, index) => [
      frame,
      join(capturedDirectory, `frame-${String(index).padStart(6, "0")}.png`),
    ]),
  );
  const hashes: string[] = [];
  const frameCount = Math.max(0, ...plan.beats.map((beat) => beat.endFrame));
  for (let frame = 0; frame < frameCount; frame++) {
    if (signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
    const reused = plan.reusedFrames.get(frame);
    const source = captured.get(frame) ?? reused?.path;
    if (!source) throw new Error("PARTIAL_RENDER_FRAME_MISSING");
    const hash = await fileSha256(source);
    if (reused && hash !== reused.sha256)
      throw new Error("PARTIAL_RENDER_FRAME_HASH_MISMATCH");
    await copyFile(
      source,
      join(canonicalDirectory, `frame-${String(frame).padStart(6, "0")}.png`),
    );
    hashes.push(hash);
  }
  return hashes;
}

export async function commitPartialRender(
  plan: PartialRenderPlan,
  canonicalDirectory: string,
  frameHashes: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (!plan.cacheDirectory) return;
  const framesDirectory = join(plan.cacheDirectory, "frames");
  await mkdir(framesDirectory, { recursive: true });
  let totalBytes = 0;
  for (const [frame, hash] of frameHashes.entries()) {
    if (signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
    const source = join(
      canonicalDirectory,
      `frame-${String(frame).padStart(6, "0")}.png`,
    );
    const frameStat = await stat(source);
    totalBytes += frameStat.size;
    if (
      !frameStat.isFile() ||
      frameStat.size > MAX_FRAME_BYTES ||
      totalBytes > MAX_CACHE_BYTES ||
      (await fileSha256(source)) !== hash
    )
      throw new Error("PARTIAL_RENDER_CACHE_RESOURCE_INVALID");
    await copyFile(source, join(framesDirectory, `${hash}.png`));
  }
  const manifest: CachedManifest = {
    schema: "rvs.partial-render-cache.v1",
    cacheKey: plan.cacheKey,
    sceneDigest: plan.sceneDigest,
    runtimeFingerprint: plan.runtimeFingerprint,
    compilerVersion: plan.compilerVersion,
    globalAssetDigest: plan.globalAssetDigest,
    beats: plan.beats.map((beat) => ({
      ...beat,
      frames: Array.from(
        { length: beat.endFrame - beat.startFrame },
        (_, offset) => {
          const frame = beat.startFrame + offset;
          const sha256 = frameHashes[frame];
          if (!sha256) throw new Error("PARTIAL_RENDER_FRAME_HASH_MISSING");
          return { frame, sha256 };
        },
      ),
    })),
  };
  const temporary = join(plan.cacheDirectory, `manifest.${randomUUID()}.json`);
  await writeFile(temporary, canonicalJson(manifest), { mode: 0o600 });
  await rename(temporary, join(plan.cacheDirectory, "manifest.json"));
  const live = new Set(frameHashes.map((hash) => `${hash}.png`));
  for (const name of await readdir(framesDirectory))
    if (!live.has(name)) await rm(join(framesDirectory, name), { force: true });
}
