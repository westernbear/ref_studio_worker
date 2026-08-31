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
  applyNativeInteraction,
  buildNativeScenePackage,
  createNativeInteractionModel,
  parseNativeInteractionEvent,
  verifyNativeScenePackage,
} from "./native-scene-package.js";

describe("native scene interactions", () => {
  it("creates typed deterministic pointer keyboard and focus bindings", () => {
    const model = createNativeInteractionModel(fixtureSpec);

    expect(model.initialState).toEqual({
      selectedElementId: "headline",
      offsets: {},
    });
    expect(new Set(model.bindings.map(({ event }) => event.kind))).toEqual(
      new Set(["pointer", "keyboard", "focus"]),
    );
    expect(JSON.stringify(model)).not.toMatch(/source|javascript|eval/iu);
  });

  it("applies allowlisted activation focus and movement while ignoring unsupported input", () => {
    const model = createNativeInteractionModel(fixtureSpec);
    const focused = applyNativeInteraction(model, model.initialState, {
      kind: "focus",
      target: "closer",
    });
    const moved = applyNativeInteraction(model, focused, {
      kind: "keyboard",
      target: "closer",
      key: "ArrowRight",
      shiftKey: true,
    });

    expect(focused.selectedElementId).toBe("closer");
    expect(moved.offsets.closer).toEqual({ x: 10, y: 0 });
    expect(
      applyNativeInteraction(model, moved, {
        kind: "pointer",
        target: "hero-image",
      }).selectedElementId,
    ).toBe("hero-image");
    expect(
      parseNativeInteractionEvent({ kind: "wheel", target: "closer" }),
    ).toBeNull();
    expect(
      parseNativeInteractionEvent({
        kind: "keyboard",
        target: "closer",
        key: "Delete",
        source: "alert(1)",
      }),
    ).toBeNull();
    expect(applyNativeInteraction(model, moved, null)).toBe(moved);
  });
});

describe("buildNativeScenePackage", () => {
  it("treats only the exact SVG XML namespace as inert metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-scene-namespace-"));
    try {
      const fontPath = join(workspace, "font.ttf");
      await writeFile(fontPath, "font");
      await expect(
        buildNativeScenePackage({
          directory: join(workspace, "valid"),
          scene: fixtureSpec,
          assetPaths: new Map(),
          fontPath,
          frames: [
            {
              frame: 0,
              markup:
                '<svg xmlns="http://www.w3.org/2000/svg"><text>offline</text></svg>',
            },
          ],
          capability: {},
          verification: {},
        }),
      ).resolves.toMatchObject({ directory: join(workspace, "valid") });
      await expect(
        buildNativeScenePackage({
          directory: join(workspace, "lookalike"),
          scene: fixtureSpec,
          assetPaths: new Map(),
          fontPath,
          frames: [
            {
              frame: 0,
              markup:
                '<svg xmlns="http://www.w3.org/2000/svg?remote"><text>unsafe</text></svg>',
            },
          ],
          capability: {},
          verification: {},
        }),
      ).rejects.toThrow("SCENE_PACKAGE_UNSAFE_CONTENT");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
      expect(html).toContain('"schema":"rvs.scene-interactions.v1"');
      expect(html).toContain('addEventListener("pointerdown"');
      expect(html).toContain('addEventListener("focus"');
      expect(html).toContain("data-selected");
      expect(html).toContain(":focus-visible");
      expect(html).toContain("min-width:44px");
      expect(html).toContain("Math.max(44,box.width)");
      expect(html).toContain('hit.setAttribute("pointer-events","all")');
      expect(html).not.toContain('addEventListener("mouseover"');
      expect(html).not.toMatch(/\beval\s*\(|new Function|https?:\/\//u);
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
    ["ftp URL", '<svg><image href="ftp://example.invalid/a.png"/></svg>'],
    ["websocket URL", '<svg><a href="ws://example.invalid/socket"/></svg>'],
    ["mail URL", '<svg><a href="mailto:private@example.invalid"/></svg>'],
    ["data URL", '<svg><image href="data:image/png;base64,AA=="/></svg>'],
    ["blob URL", '<svg><image href="blob:private"/></svg>'],
    [
      "object data URL",
      '<svg><foreignObject><object data="https://example.invalid/payload"></object></foreignObject></svg>',
    ],
    [
      "meta refresh",
      '<svg><foreignObject><meta http-equiv="refresh" content="0;url=https://example.invalid/"></foreignObject></svg>',
    ],
    [
      "iframe resource",
      '<svg><foreignObject><iframe src="assets/local.html"></iframe></foreignObject></svg>',
    ],
    ["link resource", '<svg><link href="#local" rel="stylesheet"/></svg>'],
    ["source resource", '<svg><source src="#local"/></svg>'],
    [
      "SVG animate resource",
      '<svg><rect id="target"/><animate href="#target" attributeName="fill" to="https://example.invalid/a"/></svg>',
    ],
    [
      "SVG set resource",
      '<svg><rect id="target"/><set href="#target" attributeName="fill" to="https://example.invalid/a"/></svg>',
    ],
    [
      "CSS image-set resource",
      '<svg><rect style="background-image:image-set(https://example.invalid/a.png 1x)"/></svg>',
    ],
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

  it("preserves ordinary prose and packaged hash asset references", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-scene-package-local-"));
    try {
      const assetPath = join(workspace, "source.png");
      const fontPath = join(workspace, "font.ttf");
      await writeFile(assetPath, "asset");
      await writeFile(fontPath, "font");
      const assetUrl = new URL(`file://${assetPath}`).href;
      const result = await buildNativeScenePackage({
        directory: join(workspace, "package"),
        scene: fixtureSpec,
        assetPaths: new Map([["hero", assetPath]]),
        fontPath,
        frames: [
          {
            frame: 0,
            markup: `<svg><text>ftp, websocket, mail and data are prose labels</text><image href="${assetUrl}"/></svg>`,
          },
        ],
        capability: {},
        verification: {},
      });
      const html = await readFile(join(result.directory, "index.html"), "utf8");
      expect(html).toContain("ftp, websocket, mail and data are prose labels");
      expect(html).toMatch(/href=\\"assets\/[a-f0-9]{64}\.png/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
