import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS, DELIVERY_FPS, type SceneSpec } from "./contracts/index.js";
import {
  commitPartialRender,
  materializePartialFrames,
  preparePartialRender,
  type PartialRenderPlan,
} from "./partial-render-cache.js";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const runtime = digest("runtime");
const compiler = "compiler-v1";
const spec = (): SceneSpec => ({
  schema: "scene-spec-v1",
  mode: "SWAP",
  canvas: { ...CANVAS["9:16"], fps: DELIVERY_FPS, frameCount: 9 },
  palette: {
    hero: "#ff5500",
    cool: "#3355ff",
    warm: "#ffaa33",
    background: "#101018",
  },
  assets: [
    { assetId: "image-a", kind: "image", origin: "attachment", ref: "a" },
    { assetId: "image-b", kind: "image", origin: "attachment", ref: "b" },
  ],
  beats: [0, 1, 2].map((index) => ({
    beatId: `beat-${index}`,
    startFrame: index * 3,
    endFrame: index * 3 + 3,
    shot: "hard-cut" as const,
    elements: [
      {
        elementId: `element-${index}`,
        kind: "image" as const,
        assetRef: index === 0 ? "image-a" : "image-b",
        box: { x: 0, y: 0, width: 100, height: 100 },
        keyframes: [{ frame: index * 3, opacity: 1, ease: "linear" as const }],
        effects: [],
      },
    ],
  })),
});
const assets = (a = "a", b = "b"): ReadonlyMap<string, string> =>
  new Map([
    ["image-a", digest(a)],
    ["image-b", digest(b)],
  ]);

const seed = async (
  root: string,
  scene: SceneSpec = spec(),
  assetDigests: ReadonlyMap<string, string> = assets(),
): Promise<PartialRenderPlan> => {
  const plan = await preparePartialRender({
    spec: scene,
    assetDigests,
    runtimeFingerprint: runtime,
    compilerVersion: compiler,
    cacheDirectory: join(root, "cache"),
  });
  const canonical = join(root, "canonical");
  await mkdir(canonical, { recursive: true });
  await Promise.all(
    Array.from({ length: scene.canvas.frameCount }, async (_, frame) => {
      await writeFile(
        join(canonical, `frame-${String(frame).padStart(6, "0")}.png`),
        `frame-${frame}`,
      );
    }),
  );
  await commitPartialRender(
    plan,
    canonical,
    Array.from({ length: scene.canvas.frameCount }, (_, frame) =>
      digest(`frame-${frame}`),
    ),
    new AbortController().signal,
  );
  return plan;
};

describe("partial beat render cache", () => {
  it("reuses unchanged beats and invalidates asset and transition dependants", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-partial-cache-"));
    try {
      const first = await seed(root);
      const assetChange = await preparePartialRender({
        spec: spec(),
        assetDigests: assets("changed", "b"),
        runtimeFingerprint: runtime,
        compilerVersion: compiler,
        cacheDirectory: join(root, "cache"),
      });
      const transitionScene = structuredClone(spec());
      transitionScene.beats[1] = { ...transitionScene.beats[1]!, shot: "fade" };
      const transitionChange = await preparePartialRender({
        spec: transitionScene,
        assetDigests: assets(),
        runtimeFingerprint: runtime,
        compilerVersion: compiler,
        cacheDirectory: join(root, "cache"),
      });

      expect(assetChange.renderedBeatIds).toEqual(["beat-0"]);
      expect(assetChange.reusedBeatIds).toEqual(["beat-1", "beat-2"]);
      expect(transitionChange.renderedBeatIds).toEqual(["beat-1", "beat-2"]);
      expect(assetChange.cacheKey).not.toBe(first.cacheKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to full for missing, stale, ambiguous, runtime, or compiler cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-partial-fallback-"));
    const input = {
      spec: spec(),
      assetDigests: assets(),
      runtimeFingerprint: runtime,
      compilerVersion: compiler,
      cacheDirectory: join(root, "cache"),
    };
    try {
      expect((await preparePartialRender(input)).reason).toBe(
        "missing-or-invalid",
      );
      await seed(root);
      expect(
        (
          await preparePartialRender({
            ...input,
            runtimeFingerprint: digest("next"),
          })
        ).mode,
      ).toBe("full");
      expect(
        (
          await preparePartialRender({
            ...input,
            compilerVersion: "compiler-v2",
          })
        ).mode,
      ).toBe("full");
      const audioScene: SceneSpec = {
        ...spec(),
        assets: [
          ...spec().assets,
          {
            assetId: "audio",
            kind: "audio",
            origin: "attachment",
            ref: "audio",
          },
        ],
      };
      await seed(
        root,
        audioScene,
        new Map([...assets(), ["audio", digest("one")]]),
      );
      expect(
        (
          await preparePartialRender({
            ...input,
            spec: audioScene,
            assetDigests: new Map([...assets(), ["audio", digest("two")]]),
          })
        ).reason,
      ).toBe("global-dependency-changed");
      await seed(root);
      const manifestPath = join(root, "cache", "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.beats.push(manifest.beats[0]);
      await writeFile(manifestPath, JSON.stringify(manifest));
      expect((await preparePartialRender(input)).reason).toBe("ambiguous");
      await seed(root);
      const liveManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const hash = liveManifest.beats[0].frames[0].sha256;
      await rm(join(root, "cache", "frames", `${hash}.png`));
      await symlink(
        "missing.png",
        join(root, "cache", "frames", `${hash}.png`),
      );
      expect((await preparePartialRender(input)).reason).toBe("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("assembles canonical frame order and leaves the prior manifest on cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-partial-cancel-"));
    try {
      await seed(root);
      const scene = structuredClone(spec());
      scene.beats[2]!.elements[0]!.box.x = 5;
      const plan = await preparePartialRender({
        spec: scene,
        assetDigests: assets(),
        runtimeFingerprint: runtime,
        compilerVersion: compiler,
        cacheDirectory: join(root, "cache"),
      });
      const captured = join(root, "captured");
      await mkdir(captured, { recursive: true });
      for (const [index, frame] of plan.framesToRender.entries())
        await writeFile(
          join(captured, `frame-${String(index).padStart(6, "0")}.png`),
          `changed-${frame}`,
        );
      const hashes = await materializePartialFrames(
        plan,
        captured,
        join(root, "assembled"),
        new AbortController().signal,
      );
      const manifestPath = join(root, "cache", "manifest.json");
      const before = await readFile(manifestPath, "utf8");
      await expect(
        commitPartialRender(
          plan,
          join(root, "assembled"),
          [digest("wrong"), ...hashes.slice(1)],
          new AbortController().signal,
        ),
      ).rejects.toThrow("PARTIAL_RENDER_CACHE_RESOURCE_INVALID");
      const controller = new AbortController();
      controller.abort();
      await expect(
        commitPartialRender(
          plan,
          join(root, "assembled"),
          hashes,
          controller.signal,
        ),
      ).rejects.toThrow("WORKER_JOB_CANCELLED");

      expect(hashes.slice(0, 6)).toEqual(
        Array.from({ length: 6 }, (_, frame) => digest(`frame-${frame}`)),
      );
      expect(await readFile(manifestPath, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
