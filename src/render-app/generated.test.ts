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
});
