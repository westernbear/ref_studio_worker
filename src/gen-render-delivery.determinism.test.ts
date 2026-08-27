import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { CANVAS, DELIVERY_FPS, SPEC_EFFECTS, type SceneSpec } from "./contracts/index.js";
import { describe, expect, it } from "vitest";
import { renderGeneratedDelivery } from "./gen-render-delivery.js";

// Task 2.6: the load-bearing claim of this whole design. Two independent
// runs of the same fixture, through a real (non-mocked) Chromium and
// ffmpeg, must produce byte-identical frame hashes. This is never weakened
// to a mocked capture/ffmpeg to force a green run -- if Chromium cannot
// launch in a given environment, the test is reported SKIPPED (not PASSED),
// and that must be surfaced honestly rather than hidden.
//
// This test is also the admission gate for SPEC_EFFECTS: the fixture below
// renders one element per entry in SPEC_EFFECTS (built from the list
// itself, not hand-copied), so an effect only belongs on the allowlist once
// it has passed here. blur, glow and (once this batch started painting a
// real background under a palette-aware fill) drop-shadow were all tried
// and removed after this test caught them drifting -- SPEC_EFFECTS is
// currently empty, so that map contributes no elements right now, but the
// wiring stays so the next effect proposed for the allowlist is proven or
// disproven right here. This same gate is also what I5 (image compositing,
// palette, colour assets) has to survive: the fixture below draws one of
// each, not just the effects list.
const defaultChromePath = fileURLToPath(
  new URL(
    "../../../runtime/hydrated/chrome-for-testing/chrome-linux64/chrome",
    import.meta.url,
  ),
);
const defaultFontPath = fileURLToPath(
  new URL(
    "../../../runtime/hydrated/wanted-sans/variable/WantedSansVariable.ttf",
    import.meta.url,
  ),
);
const chromePath = process.env["RVS_CHROME_PATH"] ?? defaultChromePath;
const fontPath = process.env["RVS_FONT_PATH"] ?? defaultFontPath;
const canRunRealBrowser = existsSync(chromePath) && existsSync(fontPath);

// A minimal hand-rolled PNG encoder (8-bit RGB, no interlace, one IDAT).
// Node ships no PNG encoder and this repo takes no image-library
// dependency for it -- this is the same tradeoff scene-spec.fixture.ts's
// existing "attachment://hero.png" ref makes (a ref that never needed
// real bytes until this test). deflateSync is deterministic for identical
// input within one Node process/version, which is all two renders inside
// one test run need.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
function makeSolidPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: RGB
  const ihdr = pngChunk("IHDR", ihdrData);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = rgb[0];
      raw[pixel + 1] = rgb[1];
      raw[pixel + 2] = rgb[2];
    }
  }
  const idat = pngChunk("IDAT", deflateSync(raw));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

const shortFixtureSpec: SceneSpec = {
  schema: "scene-spec-v1",
  mode: "SWAP",
  canvas: {
    width: CANVAS["9:16"].width,
    height: CANVAS["9:16"].height,
    fps: DELIVERY_FPS,
    frameCount: 6,
  },
  palette: {
    hero: "#ff5500",
    cool: "#3355ff",
    warm: "#ffaa33",
    background: "#101018",
  },
  assets: [
    {
      assetId: "hero-shot",
      kind: "image",
      origin: "attachment",
      ref: "attachment://hero.png",
    },
    {
      assetId: "wash-colour",
      kind: "color",
      origin: "evidence",
      ref: "#3355ff",
    },
  ],
  beats: [
    {
      beatId: "beat-only",
      startFrame: 0,
      endFrame: 6,
      shot: "hard-cut",
      elements: [
        // One element per allowlisted effect, derived from SPEC_EFFECTS
        // itself rather than hand-listed, so this fixture always exercises
        // the whole current allowlist -- nothing more, nothing less.
        ...SPEC_EFFECTS.map((effect, index) => ({
          elementId: `effect-${effect}`,
          kind: "text" as const,
          content: `EFFECT ${effect.toUpperCase()}`,
          box: { x: 80, y: 200 + index * 300, width: 920, height: 200 },
          keyframes: [
            { frame: 0, opacity: 0, ease: "linear" as const },
            { frame: 5, opacity: 1, ease: "easeInOut" as const },
          ],
          effects: [effect],
        })),
        // Palette item 2: a text element with no colour-asset override
        // must default to palette.hero, not the capture page's white.
        {
          elementId: "headline",
          kind: "text" as const,
          content: "PALETTE HERO TEXT",
          box: { x: 80, y: 60, width: 920, height: 120 },
          keyframes: [
            { frame: 0, opacity: 1, ease: "linear" as const },
            { frame: 5, opacity: 1, ease: "linear" as const },
          ],
          effects: [],
        },
        // Item 1: an image-kind assetRef must draw real pixels, animated
        // scale and opacity included.
        {
          elementId: "hero-image",
          kind: "image" as const,
          assetRef: "hero-shot",
          box: { x: 140, y: 900, width: 800, height: 600 },
          keyframes: [
            { frame: 0, opacity: 0.4, scale: 0.9, ease: "linear" as const },
            { frame: 5, opacity: 1, scale: 1.05, ease: "easeInOut" as const },
          ],
          effects: [],
        },
        // Item 3: a colour asset's ref stands in as a fill wherever one is
        // wanted -- here, a shape's fill.
        {
          elementId: "wash",
          kind: "shape" as const,
          assetRef: "wash-colour",
          box: { x: 900, y: 60, width: 120, height: 120 },
          keyframes: [],
          effects: [],
        },
      ],
    },
  ],
};

describe("renderGeneratedDelivery determinism", () => {
  it.skipIf(!canRunRealBrowser)(
    "produces identical frame hashes across two runs",
    async () => {
      // Each run gets its own workspace -- two genuinely independent
      // processes, not two calls sharing one Chromium profile directory
      // (which would just replay a stale DevToolsActivePort file from the
      // first run's already-exited browser). The image asset's bytes,
      // though, live at one fixed path shared by both runs: assetPaths
      // reaches the markup as a file:// URL of whatever path it is given
      // (generated.ts), so for the two runs' markup to be byte-identical
      // the path itself has to be identical, exactly like fontPath already
      // is for both.
      const workspaceA = await mkdtemp(join(tmpdir(), "rvs-gen-determinism-a-"));
      const workspaceB = await mkdtemp(join(tmpdir(), "rvs-gen-determinism-b-"));
      const assetDir = await mkdtemp(join(tmpdir(), "rvs-gen-determinism-asset-"));
      try {
        const heroShotPath = join(assetDir, "hero-shot.png");
        await writeFile(heroShotPath, makeSolidPng(64, 48, [255, 85, 0]));
        const assetPaths = new Map([["hero-shot", heroShotPath]]);

        const deps = { chromePath, fontPath };
        const a = await renderGeneratedDelivery(
          {
            spec: shortFixtureSpec,
            assetPaths,
            outPath: join(workspaceA, "out.mp4"),
          },
          deps,
        );
        const b = await renderGeneratedDelivery(
          {
            spec: shortFixtureSpec,
            assetPaths,
            outPath: join(workspaceB, "out.mp4"),
          },
          deps,
        );
        expect(b.frameSha256).toEqual(a.frameSha256);
        // Sanity that something actually rendered and changed across
        // frames, not that every frame collapsed to the same output (which
        // would make the equality assertion above vacuous): the
        // hero-image element animates opacity and scale from frame 0 to
        // frame 5.
        expect(a.frameSha256[0]).not.toBe(a.frameSha256[5]);
      } finally {
        await rm(workspaceA, { recursive: true, force: true });
        await rm(workspaceB, { recursive: true, force: true });
        await rm(assetDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
