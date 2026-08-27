import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MaterialGenerationError,
  produceMaterial,
  restrictToKind,
  unavailableMaterialProvider,
  type MaterialProvider,
  type MaterialRequest,
} from "./material-provider.js";

const request: MaterialRequest = {
  assetId: "backdrop",
  kind: "image",
  prompt: "a dark studio backdrop",
  seed: 7,
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

describe("restrictToKind", () => {
  const videoRequest: MaterialRequest = { ...request, kind: "video" };

  it("delegates a matching kind to the wrapped provider", async () => {
    const restricted = restrictToKind("image", provider({}));
    const material = await produceMaterial(restricted, request, signal);
    expect(material.bytes).toEqual(bytes);
  });

  it("refuses every other kind through the fallback, by default the fail-closed stub", async () => {
    const restricted = restrictToKind("image", provider({}));
    await expect(
      produceMaterial(restricted, videoRequest, signal),
    ).rejects.toThrow(/MATERIAL_PROVIDER_UNAVAILABLE/u);
  });

  it("never calls the wrapped provider for a kind it does not own", async () => {
    let called = false;
    const restricted = restrictToKind("image", {
      tool: "fake-provider@1",
      generate: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    await produceMaterial(restricted, videoRequest, signal).catch(
      () => undefined,
    );
    expect(called).toBe(false);
  });

  it("uses a given fallback instead of the default stub", async () => {
    const fallback: MaterialProvider = {
      tool: "video-provider@1",
      generate: async () => ({
        bytes,
        contentType: "video/mp4",
        provenance: {
          tool: "video-provider@1",
          prompt: videoRequest.prompt,
          sha256: bytesSha,
        },
      }),
    };
    const restricted = restrictToKind("image", provider({}), fallback);
    const material = await produceMaterial(restricted, videoRequest, signal);
    expect(material.provenance.tool).toBe("video-provider@1");
  });

  it("reports the wrapped provider's tool as it stands after generate(), not at construction", async () => {
    // A provider whose identity is only known once its call completes (the
    // remote OpenAI-backed provider is exactly this shape) still has to
    // pass produceMaterial's post-generate() tool check.
    let tool = "unset";
    const dynamic: MaterialProvider = {
      get tool() {
        return tool;
      },
      generate: async (req) => {
        tool = "openai:gpt-image-2";
        return {
          bytes,
          contentType: "image/png",
          provenance: { tool, prompt: req.prompt, sha256: bytesSha },
        };
      },
    };
    const restricted = restrictToKind("image", dynamic);
    const material = await produceMaterial(restricted, request, signal);
    expect(material.provenance.tool).toBe("openai:gpt-image-2");
  });
});
