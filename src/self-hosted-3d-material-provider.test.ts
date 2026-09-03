import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLENDER_SAMPLES,
  buildBlenderScript,
  canonicalizeBlenderPng,
  createSelfHosted3DMaterialProvider,
  HI3DGEN_BLENDER_TOOL,
  renderGlbWithBlender,
} from "./self-hosted-3d-material-provider.js";
import { deriveMaterialSeed } from "./material-seed.js";
import { produceMaterial, type MaterialRequest } from "./material-provider.js";
import type { CommandRunner } from "./process-runner.js";
import { REGISTERED_BLENDER } from "./blender-capability.js";

const request: MaterialRequest = {
  assetId: "hero-object",
  kind: "image",
  prompt: "a faceted glass paperweight",
  seed: null,
  // The only form that routes here -- see createMaterialProvider in index.ts.
  form: "object",
  canvas: { width: 96, height: 64, fps: 30, frameCount: 90 },
};
const signal = new AbortController().signal;

const stubFetch = (body: Uint8Array, status = 200) => {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
const capability = {
  imageDigest: REGISTERED_BLENDER.imageDigest,
  version: REGISTERED_BLENDER.version,
  device: REGISTERED_BLENDER.device,
  fixtureSha256: REGISTERED_BLENDER.fixtureSha256,
  fixturePassed: true,
  budget: REGISTERED_BLENDER.budget,
} as const;

const buildGlb = (): Uint8Array => {
  const encoded = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      accessors: [{ count: 3 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    }),
  );
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  encoded.copy(bytes, 20);
  return bytes;
};

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
  async (command, args, options) => {
    const argsPath = args.at(-1);
    if (argsPath === undefined) throw new Error("MISSING_BLENDER_ARGS_PATH");
    const localArgsPath = argsPath.startsWith("/workspace/")
      ? join(options.cwd, basename(argsPath))
      : argsPath;
    const cfg = JSON.parse(await readFile(localArgsPath, "utf8")) as {
      outputPath: string;
    };
    const bytes = typeof png === "function" ? await png(localArgsPath) : png;
    const localOutputPath = cfg.outputPath.startsWith("/workspace/")
      ? join(options.cwd, basename(cfg.outputPath))
      : cfg.outputPath;
    await writeFile(localOutputPath, bytes);
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
  afterEach(() => vi.unstubAllGlobals());

  it("refuses by name when RVS_HI3DGEN_BASE_URL is not configured", async () => {
    const provider = createSelfHosted3DMaterialProvider({ baseUrl: undefined });
    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /MATERIAL_PROVIDER_NOT_CONFIGURED/u,
    );
    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /RVS_HI3DGEN_BASE_URL/u,
    );
  });

  it("fails closed before mesh generation when the Blender capability is absent", async () => {
    const fetchMock = stubFetch(buildGlb());
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
    });
    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /BLENDER_CAPABILITY_UNAVAILABLE/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives a seed, renders at the scene's canvas size and returns image/png provenance", async () => {
    const fetchMock = stubFetch(buildGlb());
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
      capability,
      runCommand: run,
    });

    const material = await produceMaterial(provider, request, signal);

    const expectedSeed = deriveMaterialSeed(request.assetId, request.prompt);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).seed,
    ).toBe(expectedSeed);
    expect(sawSeed).toBe(expectedSeed);
    expect(material.contentType).toBe("image/png");
    expect(material.provenance.tool).toBe(HI3DGEN_BLENDER_TOOL);
    expect(material.provenance.seed).toBe(expectedSeed);
    expect(material.provenance.sha256).toBe(
      createHash("sha256").update(material.bytes).digest("hex"),
    );
  });

  it("uses the scene's own seed instead of deriving one when the scene names one", async () => {
    stubFetch(buildGlb());
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
      capability,
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
    stubFetch(buildGlb());
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
      capability,
      runCommand: run,
    });

    await produceMaterial(provider, request, signal);

    expect(sawSamples).toBe(BLENDER_SAMPLES);
  });

  it("rejects a render whose dimensions don't match the scene's canvas", async () => {
    stubFetch(buildGlb());
    const run = fakeBlender(buildFakePng(1, 1));
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      capability,
      runCommand: run,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /HI3DGEN_RENDER_QC_FAILED/u,
    );
  });

  it("rejects a render with no alpha channel", async () => {
    stubFetch(buildGlb());
    // colorType 2 = truecolour, no alpha.
    const run = fakeBlender(
      buildFakePng(request.canvas.width, request.canvas.height, 2),
    );
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      capability,
      runCommand: run,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /HI3DGEN_RENDER_QC_FAILED/u,
    );
  });

  it("propagates a client failure without inventing a placeholder", async () => {
    stubFetch(new Uint8Array(), 503);
    const provider = createSelfHosted3DMaterialProvider({
      baseUrl: "http://hi3dgen.worker-internal:8000",
      capability,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /HI3DGEN_REQUEST_FAILED/u,
    );
  });
});

describe("renderGlbWithBlender", () => {
  it("returns the same verified still hash twice", async () => {
    const commands: string[][] = [];
    const render = fakeBlender(
      buildFakePng(request.canvas.width, request.canvas.height),
    );
    const run: CommandRunner = async (command, args, options) => {
      commands.push([...args]);
      return render(command, args, options);
    };
    const options = {
      width: request.canvas.width,
      height: request.canvas.height,
      seed: 7,
      samples: BLENDER_SAMPLES,
      containerRuntimePath: "docker",
      run,
      signal,
      capability,
    } as const;
    const first = await renderGlbWithBlender(buildGlb(), options);
    const second = await renderGlbWithBlender(buildGlb(), options);
    expect(first).toEqual(second);
    expect(first.kind).toBe("still");
    expect(first.frames).toHaveLength(1);
    expect(commands.every((args) => args.includes("--disable-autoexec"))).toBe(
      true,
    );
  });

  it("publishes no frame when cancellation wins", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      renderGlbWithBlender(buildGlb(), {
        width: request.canvas.width,
        height: request.canvas.height,
        seed: 7,
        samples: BLENDER_SAMPLES,
        containerRuntimePath: "docker",
        run: async (_command, _args, options) => {
          if (options.signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
          throw new Error("MUST_NOT_RENDER");
        },
        signal: controller.signal,
        capability,
      }),
    ).rejects.toThrow(/WORKER_JOB_CANCELLED/u);
  });
});

describe("canonicalizeBlenderPng", () => {
  it("removes Blender timestamp metadata while preserving critical chunks", () => {
    const critical = buildFakePng(2, 2);
    const text = Buffer.from("rendered-at=now");
    const ancillary = Buffer.alloc(12 + text.length);
    ancillary.writeUInt32BE(text.length, 0);
    ancillary.write("tEXt", 4, "ascii");
    text.copy(ancillary, 8);
    const withMetadata = Buffer.concat([
      critical.subarray(0, 8),
      ancillary,
      critical.subarray(8),
    ]);
    expect(canonicalizeBlenderPng(withMetadata)).toEqual(critical);
  });
});
