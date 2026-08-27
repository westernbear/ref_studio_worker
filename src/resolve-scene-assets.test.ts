import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS, DELIVERY_FPS, type SceneSpec } from "./contracts/index.js";
import {
  unavailableMaterialProvider,
  type MaterialProvider,
} from "./material-provider.js";
import { resolveSceneAssets } from "./resolve-scene-assets.js";

const logoBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const signal = new AbortController().signal;

const specWith = (assets: SceneSpec["assets"]): SceneSpec => ({
  schema: "scene-spec-v1",
  mode: "SWAP",
  canvas: {
    width: CANVAS["9:16"].width,
    height: CANVAS["9:16"].height,
    fps: DELIVERY_FPS,
    frameCount: 30,
  },
  palette: {
    hero: "#ff5500",
    cool: "#3355ff",
    warm: "#ffaa33",
    background: "#101018",
  },
  assets,
  beats: [
    {
      beatId: "beat-only",
      startFrame: 0,
      endFrame: 30,
      shot: "hard-cut",
      elements: assets.map((asset, index) => ({
        elementId: `element-${index}`,
        kind: "image" as const,
        assetRef: asset.assetId,
        box: { x: 0, y: 0, width: 100, height: 100 },
        keyframes: [],
        effects: [],
      })),
    },
  ],
});

const downloadAttachment = async (
  _attachmentId: string,
  destinationPath: string,
): Promise<{ readonly contentType: string }> => {
  await writeFile(destinationPath, logoBytes);
  return { contentType: "image/png" };
};

const withWorkspace = async (
  body: (workspace: string) => Promise<void>,
): Promise<void> => {
  const workspace = await mkdtemp(join(tmpdir(), "rvs-assets-"));
  try {
    await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

describe("resolveSceneAssets", () => {
  it("writes an attachment-origin asset to disk under an extension the renderer accepts", async () => {
    await withWorkspace(async (workspace) => {
      const resolved = await resolveSceneAssets(
        {
          spec: specWith([
            {
              assetId: "logo",
              kind: "image",
              origin: "attachment",
              ref: "attachment://att_1",
            },
          ]),
          attachmentIds: ["att_1"],
          workspace,
          signal,
        },
        { downloadAttachment },
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        assetId: "logo",
        kind: "image",
        contentType: "image/png",
        sha256: createHash("sha256").update(logoBytes).digest("hex"),
        provenance: null,
      });
      expect(resolved[0]!.path.endsWith("logo.png")).toBe(true);
      expect(new Uint8Array(await readFile(resolved[0]!.path))).toEqual(
        logoBytes,
      );
    });
  });

  it("resolves nothing for a scene whose assets need no bytes", async () => {
    await withWorkspace(async (workspace) => {
      const resolved = await resolveSceneAssets(
        {
          spec: specWith([
            {
              assetId: "hero-colour",
              kind: "color",
              origin: "evidence",
              ref: "#ff5500",
            },
          ]),
          attachmentIds: [],
          workspace,
          signal,
        },
        {
          downloadAttachment: async () => {
            throw new Error("SHOULD_NOT_DOWNLOAD");
          },
        },
      );
      expect(resolved).toEqual([]);
    });
  });

  it("fails the phase when an attachment's bytes are not the kind the scene declared", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        resolveSceneAssets(
          {
            spec: specWith([
              {
                assetId: "brand-face",
                kind: "font",
                origin: "attachment",
                ref: "attachment://att_1",
              },
            ]),
            attachmentIds: ["att_1"],
            workspace,
            signal,
          },
          { downloadAttachment },
        ),
      ).rejects.toThrow(/ASSET_KIND_MISMATCH/u);
    });
  });

  it("fails the phase, with the reason, when a generated asset has no provider", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        resolveSceneAssets(
          {
            spec: specWith([
              {
                assetId: "backdrop",
                kind: "image",
                origin: "generated",
                ref: "generated://backdrop",
                provenance: {
                  tool: "author-declared",
                  prompt: "a dark studio backdrop",
                  seed: 7,
                  sha256: "0".repeat(64),
                },
              },
            ]),
            attachmentIds: [],
            workspace,
            signal,
          },
          {
            downloadAttachment,
            provider: unavailableMaterialProvider,
          },
        ),
      ).rejects.toThrow(/MATERIAL_PROVIDER_UNAVAILABLE:backdrop/u);
    });
  });

  it("records the provider's real provenance over whatever the author declared", async () => {
    await withWorkspace(async (workspace) => {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9]);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const provider: MaterialProvider = {
        tool: "fake-provider@1",
        generate: async (request) => ({
          bytes,
          contentType: "image/png" as const,
          provenance: {
            tool: "fake-provider@1",
            prompt: request.prompt,
            seed: 11,
            sha256,
          },
        }),
      };
      const resolved = await resolveSceneAssets(
        {
          spec: specWith([
            {
              assetId: "backdrop",
              kind: "image",
              origin: "generated",
              ref: "generated://backdrop",
              provenance: {
                tool: "author-declared",
                prompt: "a dark studio backdrop",
                seed: 7,
                sha256: "0".repeat(64),
              },
            },
          ]),
          attachmentIds: [],
          workspace,
          signal,
        },
        { downloadAttachment, provider },
      );
      expect(resolved[0]?.provenance).toEqual({
        tool: "fake-provider@1",
        prompt: "a dark studio backdrop",
        seed: 11,
        sha256,
      });
      expect(resolved[0]?.sha256).toBe(sha256);
    });
  });

  it("defaults to the unavailable provider, so a generated asset fails without one wired", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        resolveSceneAssets(
          {
            spec: specWith([
              {
                assetId: "backdrop",
                kind: "image",
                origin: "generated",
                ref: "generated://backdrop",
                provenance: {
                  tool: "author-declared",
                  prompt: "a dark studio backdrop",
                  sha256: "0".repeat(64),
                },
              },
            ]),
            attachmentIds: [],
            workspace,
            signal,
          },
          { downloadAttachment },
        ),
      ).rejects.toThrow(/MATERIAL_PROVIDER_UNAVAILABLE/u);
    });
  });

  it("propagates the planner's fail-closed refusal of an unresolvable attachment ref", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        resolveSceneAssets(
          {
            spec: specWith([
              {
                assetId: "logo",
                kind: "image",
                origin: "attachment",
                ref: "attachment://logo.png",
              },
            ]),
            attachmentIds: ["att_1"],
            workspace,
            signal,
          },
          { downloadAttachment },
        ),
      ).rejects.toThrow(/ASSET_ATTACHMENT_UNRESOLVED/u);
    });
  });
});
