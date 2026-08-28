import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRemoteImageMaterialProvider } from "./remote-image-material-provider.js";
import { produceMaterial, type MaterialRequest } from "./material-provider.js";
import type { WorkerApi } from "./worker-api.js";

const request: MaterialRequest = {
  assetId: "backdrop",
  kind: "image",
  prompt: "a dark studio backdrop",
  seed: 7,
  form: "flat",
  canvas: { width: 1080, height: 1920, fps: 30, frameCount: 60 },
};
const bytes = Uint8Array.from([1, 2, 3, 4]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const signal = new AbortController().signal;

describe("createRemoteImageMaterialProvider", () => {
  it("asks the API for this job's material and returns what it answers", async () => {
    const requestMaterial = vi.fn(async () => ({
      bytes,
      contentType: "image/png" as const,
      provenance: {
        tool: "openai:gpt-image-2",
        prompt: request.prompt,
        seed: 11,
        sha256,
      },
    }));
    const provider = createRemoteImageMaterialProvider(
      { requestMaterial } as unknown as Pick<WorkerApi, "requestMaterial">,
      "job-a",
    );

    const material = await produceMaterial(provider, request, signal);

    expect(requestMaterial).toHaveBeenCalledWith("job-a", request, signal);
    expect(material.bytes).toEqual(bytes);
    expect(material.provenance).toEqual({
      tool: "openai:gpt-image-2",
      prompt: request.prompt,
      seed: 11,
      sha256,
    });
  });

  it("exposes the API-declared tool once generate() has resolved", async () => {
    const requestMaterial = vi.fn(async () => ({
      bytes,
      contentType: "image/png" as const,
      provenance: { tool: "openai:gpt-image-2-2026-01-01", prompt: request.prompt, sha256 },
    }));
    const provider = createRemoteImageMaterialProvider(
      { requestMaterial } as unknown as Pick<WorkerApi, "requestMaterial">,
      "job-a",
    );

    expect(provider.tool).toBe("unset");
    await provider.generate(request, signal);
    expect(provider.tool).toBe("openai:gpt-image-2-2026-01-01");
  });

  it("propagates a failure from the API without inventing a placeholder", async () => {
    const requestMaterial = vi.fn(async () => {
      throw new Error("MATERIAL_PROVIDER_NOT_CONFIGURED");
    });
    const provider = createRemoteImageMaterialProvider(
      { requestMaterial } as unknown as Pick<WorkerApi, "requestMaterial">,
      "job-a",
    );

    await expect(
      produceMaterial(provider, request, signal),
    ).rejects.toThrow(/MATERIAL_PROVIDER_NOT_CONFIGURED/u);
  });

  it("forwards the AbortSignal it was given", async () => {
    const requestMaterial = vi.fn(async (_jobId: string, _req: MaterialRequest, sig: AbortSignal) => {
      expect(sig).toBe(signal);
      return {
        bytes,
        contentType: "image/png" as const,
        provenance: { tool: "openai:gpt-image-2", prompt: request.prompt, sha256 },
      };
    });
    const provider = createRemoteImageMaterialProvider(
      { requestMaterial } as unknown as Pick<WorkerApi, "requestMaterial">,
      "job-a",
    );

    await provider.generate(request, signal);
    expect(requestMaterial).toHaveBeenCalledOnce();
  });
});
