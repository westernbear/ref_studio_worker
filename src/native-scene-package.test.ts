import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureSpec } from "./contracts/index.js";
import { buildNativeScenePackage } from "./native-scene-package.js";

describe("buildNativeScenePackage", () => {
  it("builds a hash-bound offline editable package without external URLs", async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "rvs-scene-package-"));
    try {
      const assetPath = join(workspace, "source.png");
      const fontPath = join(workspace, "font.ttf");
      await writeFile(assetPath, "asset-bytes");
      await writeFile(fontPath, "font-bytes");

      // When
      const result = await buildNativeScenePackage({
        directory: join(workspace, "package"),
        scene: fixtureSpec,
        assetPaths: new Map([["hero-shot", assetPath]]),
        fontPath,
        frames: [
          {
            frame: 0,
            markup: `<svg><image href="${new URL(`file://${assetPath}`).href}" /></svg>`,
          },
        ],
        capability: { video: false, rotation: false },
        verification: { status: "PASS", repeatedFrameByteIdentity: true },
      });

      // Then
      const html = await readFile(join(result.directory, "index.html"), "utf8");
      const manifest = JSON.parse(
        await readFile(join(result.directory, "manifest.json"), "utf8"),
      ) as { files: Readonly<Record<string, string>> };
      expect(html).not.toMatch(/https?:|file:/u);
      expect(
        JSON.parse(
          await readFile(join(result.directory, "scene.json"), "utf8"),
        ),
      ).toEqual(fixtureSpec);
      for (const [path, digest] of Object.entries(manifest.files))
        expect(
          createHash("sha256")
            .update(await readFile(join(result.directory, path)))
            .digest("hex"),
        ).toBe(digest);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
