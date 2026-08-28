import { pathToFileURL } from "node:url";
import { fixtureSpec, type SceneSpec } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compileSceneSpec } from "../scene/spec-compile.js";
import { createGeneratedRenderApp } from "./generated.js";

const withElement = (
  spec: SceneSpec,
  patch: Partial<SceneSpec["beats"][number]["elements"][number]>,
): SceneSpec => {
  const next = structuredClone(spec) as SceneSpec;
  Object.assign(next.beats[0]!.elements[0]!, patch);
  return next;
};

describe("createGeneratedRenderApp", () => {
  it("emits svg markup for a frame", () => {
    const app = createGeneratedRenderApp(compileSceneSpec(fixtureSpec), []);
    expect(app.renderFrame(0).markup).toContain("<svg");
  });

  it("escapes text content", () => {
    const spec = withElement(fixtureSpec, {
      kind: "text",
      content: "<script>x</script>",
    });
    const app = createGeneratedRenderApp(compileSceneSpec(spec), []);
    expect(app.renderFrame(0).markup).not.toContain("<script>");
  });

  it("refuses a font that is not local", () => {
    expect(() =>
      createGeneratedRenderApp(compileSceneSpec(fixtureSpec), [
        { family: "Bad", path: "https://fonts.example.com/bad.woff2" },
      ]),
    ).toThrow(/NONLOCAL_FONT/);
  });

  it("is byte-identical across two calls", () => {
    const app = createGeneratedRenderApp(compileSceneSpec(fixtureSpec), []);
    expect(app.renderFrame(42).markup).toBe(app.renderFrame(42).markup);
  });

  it("paints the ground from the palette's background colour", () => {
    const app = createGeneratedRenderApp(compileSceneSpec(fixtureSpec), []);
    const markup = app.renderFrame(0).markup;
    expect(markup).toContain(
      `<rect data-element-id="scene-background" x="0" y="0" width="${fixtureSpec.canvas.width}" height="${fixtureSpec.canvas.height}" fill="${fixtureSpec.palette.background}" stroke="none" style="rx:0" />`,
    );
    // Painted before anything else, so real content layers on top of it.
    expect(markup.indexOf('data-element-id="scene-background"')).toBeLessThan(
      markup.indexOf('data-element-id="headline"'),
    );
  });

  it("defaults a text element's fill to the palette's hero colour", () => {
    const app = createGeneratedRenderApp(compileSceneSpec(fixtureSpec), []);
    const markup = app.renderFrame(0).markup;
    expect(markup).toContain(`fill="${fixtureSpec.palette.hero}"`);
  });

  it("uses a colour asset's ref as a fill wherever one is wanted", () => {
    const spec: SceneSpec = {
      ...fixtureSpec,
      assets: [
        ...fixtureSpec.assets,
        {
          assetId: "wash-colour",
          kind: "color",
          origin: "evidence",
          ref: "#112233",
        },
      ],
      beats: [
        {
          ...fixtureSpec.beats[0]!,
          elements: [
            ...fixtureSpec.beats[0]!.elements,
            {
              elementId: "wash",
              kind: "shape",
              assetRef: "wash-colour",
              box: { x: 0, y: 0, width: 1080, height: 1920 },
              keyframes: [],
              effects: [],
            },
          ],
        },
        ...fixtureSpec.beats.slice(1),
      ],
    };
    const app = createGeneratedRenderApp(
      compileSceneSpec(spec),
      [],
      spec.assets,
    );
    const markup = app.renderFrame(0).markup;
    const washIndex = markup.indexOf('data-element-id="wash"');
    expect(washIndex).toBeGreaterThan(-1);
    expect(markup.slice(washIndex, washIndex + 200)).toContain(
      'fill="#112233"',
    );
  });

  // fixtureSpec's beat-hero (frames 200-399) draws "hero-image", assetRef
  // "hero-shot", an image-kind asset -- the whole point of the material
  // provider (item 1).
  it("draws an image asset at its box as a local file:// reference", () => {
    const assetPaths = new Map([["hero-shot", "/tmp/hero-shot.png"]]);
    const app = createGeneratedRenderApp(
      compileSceneSpec(fixtureSpec),
      [],
      fixtureSpec.assets,
      assetPaths,
    );
    const markup = app.renderFrame(250).markup;
    const href = pathToFileURL("/tmp/hero-shot.png").href;
    expect(markup).toContain(`data-element-id="hero-image"`);
    expect(markup).toContain(`href="${href}"`);
    // The background ground still paints as a <rect>; the hero-image
    // element itself must be an <image>, not the old unfilled-rect
    // placeholder.
    const heroIndex = markup.indexOf('data-element-id="hero-image"');
    const tagStart = markup.lastIndexOf("<", heroIndex);
    expect(markup.slice(tagStart, tagStart + 6)).toBe("<image");
  });

  it("gives a shape with no colour-asset override a visible, palette-derived fill", () => {
    const spec: SceneSpec = {
      ...fixtureSpec,
      beats: [
        {
          ...fixtureSpec.beats[0]!,
          elements: [
            ...fixtureSpec.beats[0]!.elements,
            {
              elementId: "bare-shape",
              kind: "shape",
              box: { x: 10, y: 10, width: 50, height: 50 },
              keyframes: [],
              effects: [],
            },
          ],
        },
        ...fixtureSpec.beats.slice(1),
      ],
    };
    const app = createGeneratedRenderApp(compileSceneSpec(spec), []);
    const markup = app.renderFrame(0).markup;
    const shapeIndex = markup.indexOf('data-element-id="bare-shape"');
    expect(shapeIndex).toBeGreaterThan(-1);
    const tag = markup.slice(markup.lastIndexOf("<", shapeIndex), markup.indexOf("/>", shapeIndex) + 2);
    expect(tag).toContain(`fill="${fixtureSpec.palette.cool}"`);
  });

  // "glow" is not in SPEC_EFFECTS -- it was tried as geometry (a scaled-up,
  // lower-opacity copy) and dropped a second time: even pixel-snapped and
  // cut to a single layer, it still failed the determinism gate
  // intermittently under concurrent CPU load (see SPEC_EFFECTS's own
  // comment in packages/contracts/src/scene-spec.ts and
  // gen-render-delivery.determinism.test.ts's run log). An element that
  // names "glow" therefore draws no extra layer for it -- same as any
  // other effect name outside the allowlist.
  it("draws no extra layer for an effect name outside the allowlist (e.g. glow)", () => {
    const spec = withElement(fixtureSpec, { effects: ["glow"] });
    const app = createGeneratedRenderApp(compileSceneSpec(spec), []);
    const markup = app.renderFrame(0).markup;
    expect(markup).not.toContain("filter=");
    expect(markup).not.toContain("<filter");
    expect(markup).not.toContain("headline__effect-glow");
  });

  it("draws a drop shadow as one offset, darkened copy beneath the element", () => {
    const spec = withElement(fixtureSpec, { effects: ["drop-shadow"] });
    const app = createGeneratedRenderApp(compileSceneSpec(spec), []);
    const markup = app.renderFrame(0).markup;
    expect(markup).not.toContain("filter=");
    const shadowIndex = markup.indexOf(
      'data-element-id="headline__effect-drop-shadow"',
    );
    expect(shadowIndex).toBeGreaterThan(-1);
    expect(markup.indexOf('data-element-id="headline__effect-drop-shadow"')).toBeLessThan(
      markup.indexOf('data-element-id="headline"'),
    );
    // The shadow's colour comes from the palette's background, not a
    // hardcoded black.
    expect(markup.slice(shadowIndex, shadowIndex + 200)).toContain(
      `fill="${fixtureSpec.palette.background}"`,
    );
  });

  it("skips drop-shadow for an image-kind element (no geometry for a silhouette)", () => {
    const assetPaths = new Map([["hero-shot", "/tmp/hero-shot.png"]]);
    const spec: SceneSpec = {
      ...fixtureSpec,
      beats: [
        fixtureSpec.beats[0]!,
        {
          ...fixtureSpec.beats[1]!,
          elements: [
            { ...fixtureSpec.beats[1]!.elements[0]!, effects: ["drop-shadow"] },
          ],
        },
        ...fixtureSpec.beats.slice(2),
      ],
    };
    const app = createGeneratedRenderApp(
      compileSceneSpec(spec),
      [],
      spec.assets,
      assetPaths,
    );
    const markup = app.renderFrame(250).markup;
    expect(markup).not.toContain("hero-image__effect");
  });

  it("refuses to resolve an image asset to a remote-looking path", () => {
    const assetPaths = new Map([
      ["hero-shot", "https://cdn.example.com/hero.png"],
    ]);
    expect(() =>
      createGeneratedRenderApp(
        compileSceneSpec(fixtureSpec),
        [],
        fixtureSpec.assets,
        assetPaths,
      ),
    ).toThrow(/REMOTE_ASSET_PATH_REJECTED/);
  });

  it("fails closed when an image asset has no resolved path", () => {
    const app = createGeneratedRenderApp(
      compileSceneSpec(fixtureSpec),
      [],
      fixtureSpec.assets,
    );
    expect(() => app.renderFrame(250)).toThrow(/ASSET_PATH_UNRESOLVED/);
  });
});
