import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMaterialProvider,
  MaterialGenerationError,
  produceMaterial,
  unavailableMaterialProvider,
  type MaterialProvider,
  type MaterialRequest,
} from "./material-provider.js";

const request: MaterialRequest = {
  assetId: "backdrop",
  kind: "image",
  prompt: "a dark studio backdrop",
  seed: 7,
  form: "flat",
  canvas: { width: 1080, height: 1920, fps: 30, frameCount: 600 },
};
const bytes = Uint8Array.from([1, 2, 3, 4]);
const bytesSha = createHash("sha256").update(bytes).digest("hex");
const signal = new AbortController().signal;

const provider = (
  material: Partial<Awaited<ReturnType<MaterialProvider["generate"]>>>,
): MaterialProvider => ({
  tool: "fake-provider@1",
  generate: async () =>
    ({
      bytes,
      contentType: "image/png",
      provenance: {
        tool: "fake-provider@1",
        prompt: request.prompt,
        seed: 7,
        sha256: bytesSha,
      },
      ...material,
    }) as Awaited<ReturnType<MaterialProvider["generate"]>>,
});

describe("the material provider seam", () => {
  it("the only wired provider refuses every generated asset, by name", async () => {
    await expect(
      produceMaterial(unavailableMaterialProvider, request, signal),
    ).rejects.toThrow(/MATERIAL_PROVIDER_UNAVAILABLE/u);
    await expect(
      produceMaterial(unavailableMaterialProvider, request, signal),
    ).rejects.toThrow(/backdrop/u);
  });

  it("passes a provider's material through once its provenance checks out", async () => {
    const material = await produceMaterial(provider({}), request, signal);
    expect(material.provenance).toEqual({
      tool: "fake-provider@1",
      prompt: "a dark studio backdrop",
      seed: 7,
      sha256: bytesSha,
    });
    expect(material.bytes).toEqual(bytes);
  });

  it("rejects material whose recorded hash is not the hash of the bytes it returned", async () => {
    await expect(
      produceMaterial(
        provider({
          provenance: {
            tool: "fake-provider@1",
            prompt: request.prompt,
            seed: 7,
            sha256: "0".repeat(64),
          },
        }),
        request,
        signal,
      ),
    ).rejects.toThrow(/MATERIAL_PROVENANCE_MISMATCH/u);
  });

  it("rejects material recorded against a prompt other than the one asked for", async () => {
    await expect(
      produceMaterial(
        provider({
          provenance: {
            tool: "fake-provider@1",
            prompt: "something else entirely",
            seed: 7,
            sha256: bytesSha,
          },
        }),
        request,
        signal,
      ),
    ).rejects.toThrow(/MATERIAL_PROVENANCE_MISMATCH/u);
  });

  it("rejects material recorded against a tool other than the provider that made it", async () => {
    await expect(
      produceMaterial(
        provider({
          provenance: {
            tool: "some-other-tool",
            prompt: request.prompt,
            seed: 7,
            sha256: bytesSha,
          },
        }),
        request,
        signal,
      ),
    ).rejects.toThrow(/MATERIAL_PROVENANCE_MISMATCH/u);
  });

  it("rejects a content type the renderer has no way to read", async () => {
    await expect(
      produceMaterial(
        provider({ contentType: "application/zip" }),
        request,
        signal,
      ),
    ).rejects.toThrow(/MATERIAL_CONTENT_TYPE_INVALID/u);
  });

  it("rejects empty bytes rather than storing a zero-length asset", async () => {
    await expect(
      produceMaterial(
        provider({
          bytes: new Uint8Array(),
          provenance: {
            tool: "fake-provider@1",
            prompt: request.prompt,
            seed: 7,
            sha256: createHash("sha256").update(new Uint8Array()).digest("hex"),
          },
        }),
        request,
        signal,
      ),
    ).rejects.toThrow(/MATERIAL_EMPTY/u);
  });

  it("carries a MaterialGenerationError token and the asset it belongs to", async () => {
    const error = await produceMaterial(
      unavailableMaterialProvider,
      request,
      signal,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MaterialGenerationError);
    expect((error as MaterialGenerationError).token).toBe(
      "MATERIAL_PROVIDER_UNAVAILABLE",
    );
    expect((error as MaterialGenerationError).assetId).toBe("backdrop");
  });
});

describe("createMaterialProvider", () => {
  const videoRequest: MaterialRequest = { ...request, kind: "video" };
  const objectRequest: MaterialRequest = { ...request, form: "object" };
  const objectProvider: MaterialProvider = {
    tool: "object-provider@1",
    generate: async (req) => ({
      bytes,
      contentType: "image/png",
      provenance: {
        tool: "object-provider@1",
        prompt: req.prompt,
        sha256: bytesSha,
      },
    }),
  };
  const videoProvider: MaterialProvider = {
    tool: "video-provider@1",
    generate: async (req) => ({
      bytes,
      contentType: "video/mp4",
      provenance: {
        tool: "video-provider@1",
        prompt: req.prompt,
        sha256: bytesSha,
      },
    }),
  };

  it("sends a flat image request through requestImage", async () => {
    const routed = createMaterialProvider({
      requestImage: async () => ({
        bytes,
        contentType: "image/png",
        provenance: {
          tool: "openai:gpt-image-2",
          prompt: request.prompt,
          sha256: bytesSha,
        },
      }),
    });
    const material = await produceMaterial(routed, request, signal);
    expect(material.provenance.tool).toBe("openai:gpt-image-2");
  });

  it("routes object-form image requests to the object provider", async () => {
    let imageCalled = false;
    const routed = createMaterialProvider({
      requestImage: async () => {
        imageCalled = true;
        throw new Error("must not be called");
      },
      object: objectProvider,
    });
    const material = await produceMaterial(routed, objectRequest, signal);
    expect(material.provenance.tool).toBe("object-provider@1");
    expect(imageCalled).toBe(false);
  });

  it("routes video requests to the video provider", async () => {
    const routed = createMaterialProvider({ video: videoProvider });
    const material = await produceMaterial(routed, videoRequest, signal);
    expect(material.provenance.tool).toBe("video-provider@1");
  });

  it("refuses a kind with no wired provider through the fail-closed stub", async () => {
    const routed = createMaterialProvider({
      requestImage: async () => ({
        bytes,
        contentType: "image/png",
        provenance: {
          tool: "openai:gpt-image-2",
          prompt: request.prompt,
          sha256: bytesSha,
        },
      }),
    });
    await expect(
      produceMaterial(routed, videoRequest, signal),
    ).rejects.toThrow(/MATERIAL_PROVIDER_UNAVAILABLE/u);
  });

  it("exposes the API-declared tool once requestImage has resolved", async () => {
    const routed = createMaterialProvider({
      requestImage: async (req) => ({
        bytes,
        contentType: "image/png",
        provenance: {
          tool: "openai:gpt-image-2",
          prompt: req.prompt,
          sha256: bytesSha,
        },
      }),
    });
    expect(routed.tool).toBe("unset");
    await produceMaterial(routed, request, signal);
    expect(routed.tool).toBe("openai:gpt-image-2");
  });

  it("reports whichever provider actually served the request as its tool", async () => {
    const routed = createMaterialProvider({
      requestImage: async (req) => ({
        bytes,
        contentType: "image/png",
        provenance: {
          tool: "flat-provider@1",
          prompt: req.prompt,
          sha256: bytesSha,
        },
      }),
      object: objectProvider,
    });
    await produceMaterial(routed, objectRequest, signal);
    expect(routed.tool).toBe("object-provider@1");
    await produceMaterial(routed, request, signal);
    expect(routed.tool).toBe("flat-provider@1");
  });
});
