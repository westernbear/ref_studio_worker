import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BLENDER_SAMPLES,
  buildBlenderScript,
  createSelfHosted3DMaterialProvider,
  HI3DGEN_BLENDER_TOOL,
  type Hi3DGenClient,
} from "./self-hosted-3d-material-provider.js";
import { deriveMaterialSeed } from "./material-seed.js";
import { produceMaterial, type MaterialRequest } from "./material-provider.js";
import type { CommandRunner } from "./process-runner.js";

const request: MaterialRequest = {
  assetId: "hero-object",
  kind: "image",
  prompt: "a faceted glass paperweight",
  seed: null,
  // The only form that routes here -- see restrictToForm in index.ts.
  form: "object",
  canvas: { width: 96, height: 64, fps: 30, frameCount: 90 },
};
const signal = new AbortController().signal;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const buildFakePng = (
  width: number,
  height: number,
  colorType = 6,
): Uint8Array => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(colorType, 9);
  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(13, 0);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      chunkLength,
      Buffer.from("IHDR", "ascii"),
      ihdr,
      Buffer.alloc(4),
    ]),
  );
};

// A fake Blender: reads the args JSON file (the same way the real
// render.py script would) to find out where to write, and writes a
// fixture PNG there instead of actually rendering anything.
const fakeBlender =
  (
    png: Uint8Array | ((argsPath: string) => Promise<Uint8Array>),
  ): CommandRunner =>
  async (command, args) => {
    const argsPath = args.at(-1) as string;
    const cfg = JSON.parse(await readFile(argsPath, "utf8")) as {
      outputPath: string;
    };
    const bytes = typeof png === "function" ? await png(argsPath) : png;
    await writeFile(cfg.outputPath, bytes);
    return { stdout: "", stderr: "" };
  };

describe("buildBlenderScript", () => {
  const script = buildBlenderScript();
  it("pins one compute device, CPU, never CUDA/OptiX", () => {
    expect(script).toContain('scene.cycles.device = "CPU"');
  });
  it("pins a fixed sample count with no adaptive sampling", () => {
    expect(script).toContain('scene.cycles.samples = cfg["samples"]');
    expect(script).toContain("scene.cycles.use_adaptive_sampling = False");
  });
  it("disables the denoiser", () => {
    expect(script).toContain("scene.cycles.use_denoising = False");
  });
  it("pins a single render thread", () => {
    expect(script).toContain('scene.render.threads_mode = "FIXED"');
    expect(script).toContain("scene.render.threads = 1");
  });
  it("pins the seed from the args file rather than leaving it random", () => {
    expect(script).toContain('scene.cycles.seed = cfg["seed"]');
  });
  it("renders with a transparent film so the still composites like any other image asset", () => {
    expect(script).toContain("scene.render.film_transparent = True");
  });
});

describe("createSelfHosted3DMaterialProvider", () => {
  it("refuses by name when RVS_HI3DGEN_BASE_URL is not configured", async () => {
    const provider = createSelfHosted3DMaterialProvider({ baseUrl: undefined });
    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /MATERIAL_PROVIDER_NOT_CONFIGURED/u,
    );
    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /RVS_HI3DGEN_BASE_URL/u,
    );
  });

  it("derives a seed, renders at the scene's canvas size and returns image/png provenance", async () => {
    const clientCalls: Array<{ prompt: string; seed: number }> = [];
    const client: Hi3DGenClient = async (baseUrl, req) => {
      clientCalls.push(req);
      return Uint8Array.from([1, 2, 3]);
    };
    let sawSeed: number | undefined;
    const run = fakeBlender(async (argsPath) => {
      const cfg = JSON.parse(await readFile(argsPath, "utf8")) as {
        seed: number;
        width: number;
        height: number;
      };
      sawSeed = cfg.seed;
      return buildFakePng(cfg.width, cfg.height);
    });
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      client,
      runCommand: run,
    });

    const material = await produceMaterial(provider, request, signal);

    const expectedSeed = deriveMaterialSeed(request.assetId, request.prompt);
    expect(clientCalls[0]?.seed).toBe(expectedSeed);
    expect(sawSeed).toBe(expectedSeed);
    expect(material.contentType).toBe("image/png");
    expect(material.provenance.tool).toBe(HI3DGEN_BLENDER_TOOL);
    expect(material.provenance.seed).toBe(expectedSeed);
    expect(material.provenance.sha256).toBe(
      createHash("sha256").update(material.bytes).digest("hex"),
    );
  });

  it("uses the scene's own seed instead of deriving one when the scene names one", async () => {
    const client: Hi3DGenClient = async () => Uint8Array.from([1]);
    let sawSeed: number | undefined;
    const run = fakeBlender(async (argsPath) => {
      const cfg = JSON.parse(await readFile(argsPath, "utf8")) as {
        seed: number;
        width: number;
        height: number;
      };
      sawSeed = cfg.seed;
      return buildFakePng(cfg.width, cfg.height);
    });
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      client,
      runCommand: run,
    });

    const material = await produceMaterial(
      provider,
      { ...request, seed: 99 },
      signal,
    );

    expect(sawSeed).toBe(99);
    expect(material.provenance.seed).toBe(99);
  });

  it("uses the configured sample count, defaulting to BLENDER_SAMPLES", async () => {
    const client: Hi3DGenClient = async () => Uint8Array.from([1]);
    let sawSamples: number | undefined;
    const run = fakeBlender(async (argsPath) => {
      const cfg = JSON.parse(await readFile(argsPath, "utf8")) as {
        samples: number;
        width: number;
        height: number;
      };
      sawSamples = cfg.samples;
      return buildFakePng(cfg.width, cfg.height);
    });
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      client,
      runCommand: run,
    });

    await produceMaterial(provider, request, signal);

    expect(sawSamples).toBe(BLENDER_SAMPLES);
  });

  it("rejects a render whose dimensions don't match the scene's canvas", async () => {
    const client: Hi3DGenClient = async () => Uint8Array.from([1]);
    const run = fakeBlender(buildFakePng(1, 1));
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      client,
      runCommand: run,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /HI3DGEN_RENDER_QC_FAILED/u,
    );
  });

  it("rejects a render with no alpha channel", async () => {
    const client: Hi3DGenClient = async () => Uint8Array.from([1]);
    // colorType 2 = truecolour, no alpha.
    const run = fakeBlender(
      buildFakePng(request.canvas.width, request.canvas.height, 2),
    );
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      client,
      runCommand: run,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /HI3DGEN_RENDER_QC_FAILED/u,
    );
  });

  it("propagates a client failure without inventing a placeholder", async () => {
    const client: Hi3DGenClient = async () => {
      throw new Error("HI3DGEN_REQUEST_FAILED:503");
    };
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      client,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /HI3DGEN_REQUEST_FAILED/u,
    );
  });
});
