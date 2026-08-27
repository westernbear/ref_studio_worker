import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
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
