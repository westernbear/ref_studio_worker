import { createHash } from "node:crypto";
import {
  cp,
  readFile,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureSpec } from "./contracts/index.js";
import {
  buildNativeScenePackage,
  verifyNativeScenePackage,
} from "./native-scene-package.js";

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
      ) as {
        schema: string;
        sceneDigest: string;
        runtimeFingerprint: string;
        creationPolicy: Readonly<Record<string, unknown>>;
        files: readonly Readonly<{
          path: string;
          sha256: string;
          bytes: number;
        }>[];
      };
      expect(html).not.toMatch(/https?:|file:/u);
      expect(html).toContain("default-src 'none'");
      expect(html).toContain('id="play-pause"');
      expect(html).toContain('id="frame-scrub"');
      expect(html).toContain('event.key === "ArrowRight"');
      expect(html).toContain("prefers-reduced-motion: reduce");
      expect(manifest.schema).toBe("rvs.native-scene-package.v2");
      expect(manifest.sceneDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.creationPolicy).toEqual({
        assets: "sha256-named",
        externalUrls: "forbidden",
        generatedAt: "omitted-for-reproducibility",
      });
      expect(
        JSON.parse(
          await readFile(join(result.directory, "scene.json"), "utf8"),
        ),
      ).toEqual(fixtureSpec);
      expect(manifest.files.map(({ path }) => path)).toEqual(
        [...manifest.files.map(({ path }) => path)].sort(),
      );
      for (const { path, sha256, bytes } of manifest.files) {
        const contents = await readFile(join(result.directory, path));
        expect(createHash("sha256").update(contents).digest("hex")).toBe(
          sha256,
        );
        expect(contents.byteLength).toBe(bytes);
      }
      await expect(
        verifyNativeScenePackage(result.directory),
      ).resolves.toBeUndefined();

      const second = await buildNativeScenePackage({
        directory: join(workspace, "package-second"),
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
      expect(await readFile(second.manifestPath)).toEqual(
        await readFile(result.manifestPath),
      );
      expect(await readFile(join(second.directory, "index.html"))).toEqual(
        await readFile(join(result.directory, "index.html")),
      );

      const corrupt = join(workspace, "corrupt");
      await cp(result.directory, corrupt, { recursive: true });
      await writeFile(join(corrupt, "scene.json"), "{}\n");
      await expect(verifyNativeScenePackage(corrupt)).rejects.toThrow(
        "PACKAGE_INTEGRITY_FAILED",
      );

      const missing = join(workspace, "missing");
      await cp(result.directory, missing, { recursive: true });
      await unlink(join(missing, "scene.json"));
      await expect(verifyNativeScenePackage(missing)).rejects.toThrow(
        "PACKAGE_INTEGRITY_FAILED",
      );

      const added = join(workspace, "added");
      await cp(result.directory, added, { recursive: true });
      await writeFile(join(added, "surprise.txt"), "nope");
      await expect(verifyNativeScenePackage(added)).rejects.toThrow(
        "PACKAGE_INTEGRITY_FAILED",
      );

      const linked = join(workspace, "linked");
      await cp(result.directory, linked, { recursive: true });
      await symlink(
        join(linked, "scene.json"),
        join(linked, "scene-link.json"),
      );
      await expect(verifyNativeScenePackage(linked)).rejects.toThrow(
        "PACKAGE_INTEGRITY_FAILED",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "external URL",
      '<svg><image href="https://example.invalid/a.png"/></svg>',
    ],
    ["file URL", '<svg><image href="file:///tmp/private.png"/></svg>'],
    [
      "remote font",
      "<svg><style>@font-face{src:url(//example.invalid/a.woff)}</style></svg>",
    ],
    ["script", "<svg><script>alert(1)</script></svg>"],
    ["eval", "<svg><text>eval(unsafe)</text></svg>"],
    ["traversal", '<svg><image href="../private.png"/></svg>'],
    ["absolute path", '<svg><image href="/tmp/private.png"/></svg>'],
  ])("rejects %s markup", async (_name, markup) => {
    const workspace = await mkdtemp(
      join(tmpdir(), "rvs-scene-package-hostile-"),
    );
    try {
      const fontPath = join(workspace, "font.ttf");
      await writeFile(fontPath, "font");
      await expect(
        buildNativeScenePackage({
          directory: join(workspace, "package"),
          scene: fixtureSpec,
          assetPaths: new Map(),
          fontPath,
          frames: [{ frame: 0, markup }],
          capability: {},
          verification: {},
        }),
      ).rejects.toThrow("SCENE_PACKAGE_UNSAFE_CONTENT");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
