import { describe, expect, it } from "vitest";
import type { BrowserPassSpec, Pass, SceneIR } from "../scene/compile.js";
import {
  createRenderPlan,
  shaderSources,
  validateContext,
  validateShaderDiagnostics,
  type ContextProbe,
  type ShaderDiagnostics,
} from "./webgl.js";

const owners = ["title", "ui", "residual"] as const;
const layers = [
  "background-layer",
  "behind-ui-layer",
  "semantic-ui-layer",
  "copy-layer",
  "owner-treatment-layer",
  "over-ui-layer",
  "final-frame",
] as const;
const context: ContextProbe = {
  webgl2: true,
  renderer: "webgl2",
  canvasFallback: false,
  softwareRenderer: false,
  premultipliedAlpha: false,
  colorSpace: "srgb",
  extensions: ["EXT_color_buffer_float"],
  limits: { MAX_TEXTURE_SIZE: 4096, MAX_RENDERBUFFER_SIZE: 4096 },
};
const diagnostics: readonly ShaderDiagnostics[] = [
  { shader: "dynamic-nonuniform-rim", compiled: true, linked: true, log: "" },
  { shader: "owner-bloom-defocus", compiled: true, linked: true, log: "" },
  { shader: "lower-light-field-13tap", compiled: true, linked: true, log: "" },
  { shader: "residual-gradient", compiled: true, linked: true, log: "" },
  { shader: "residual-light-pool", compiled: true, linked: true, log: "" },
  { shader: "residual-sparkles", compiled: true, linked: true, log: "" },
  {
    shader: "display-referred-soft-toe-024",
    compiled: true,
    linked: true,
    log: "",
  },
];
const scene: SceneIR = {
  schema: "scene-ir-v1",
  tenantId: "tenant",
  authoringVersionId: "air",
  versionId: "sir",
  digest: "digest",
  parentDigest: "air-digest",
  editor: "editor",
  reason: "T26",
  timestamp: "2026-08-22T00:00:00.000Z",
  tracks: owners.map((owner) => ({
    trackId: owner,
    owner,
    lifecycle: { enter: {}, stable: {}, exit: {} },
    geometryRef: owner,
    effects:
      owner === "residual"
        ? ["residual-canvas"]
        : owner === "ui"
          ? ["bloom", "defocus", "rim"]
          : ["bloom", "defocus"],
  })),
  geometry: Object.fromEntries(
    owners.map((owner) => [
      owner,
      { boundsPerFrame: [], fixedWidth: true, fixedX: true },
    ]),
  ),
  effects: {
    title: { bloom: { measured: 1 }, defocus: { measured: 2 } },
    ui: {
      bloom: { measured: 3 },
      defocus: { measured: 4 },
      rim: { measured: 5 },
    },
    residual: { "residual-canvas": { measured: 6 } },
  },
  residualCanvas: {
    owner: "residual",
    measurements: [
      "lower-light field",
      "gradient mesh",
      "light pool",
      "sparkles",
    ],
    mustRemainSeparate: true,
    compositeRule: "before owner effects",
  },
  audio: { sampleRateHz: 48000, channels: 2, anchors: [] },
};
const pass = (
  passId: string,
  owner: string,
  kind: Pass["kind"],
  shader: Pass["shader"],
  reads: readonly string[],
  writes: string,
): Pass => ({ passId, owner, kind, shader, reads, writes });
const spec: BrowserPassSpec = {
  schema: "browser-pass-spec-v1",
  tenantId: "tenant",
  sceneVersionId: "sir",
  versionId: "bps",
  digest: "digest",
  parentDigest: "sir-digest",
  editor: "editor",
  reason: "T26",
  timestamp: "2026-08-22T00:00:00.000Z",
  approvalDigest: "scene",
  previewDigest: "scene",
  renderDigest: "scene",
  layerOrder: layers,
  passList: [
    pass(
      "background-dom",
      "residual",
      "DOM/SVG",
      null,
      ["background"],
      "background-layer",
    ),
    pass(
      "residual-gradient",
      "residual",
      "WebGL2",
      "residual-gradient",
      ["residualCanvas.gradient mesh"],
      "background-layer",
    ),
    pass(
      "residual-light-pool",
      "residual",
      "WebGL2",
      "residual-light-pool",
      ["residualCanvas.light pool"],
      "background-layer",
    ),
    pass(
      "residual-sparkles",
      "residual",
      "WebGL2",
      "residual-sparkles",
      ["residualCanvas.sparkles"],
      "background-layer",
    ),
    pass(
      "lower-light-behind",
      "residual",
      "WebGL2",
      "lower-light-field-13tap",
      ["residualCanvas.lower-light field"],
      "behind-ui-layer",
    ),
    pass("ui", "ui", "DOM/SVG", null, ["ui"], "semantic-ui-layer"),
    pass("copy", "title", "DOM/SVG", null, ["font"], "copy-layer"),
    pass(
      "treatment",
      "title,ui",
      "WebGL2",
      "owner-bloom-defocus",
      ["effects"],
      "owner-treatment-layer",
    ),
    pass(
      "rim",
      "ui",
      "WebGL2",
      "dynamic-nonuniform-rim",
      ["rim"],
      "over-ui-layer",
    ),
    pass(
      "lower-light-over",
      "residual",
      "WebGL2",
      "lower-light-field-13tap",
      ["residualCanvas.lower-light field"],
      "over-ui-layer",
    ),
    pass(
      "final",
      "residual",
      "WebGL2",
      "display-referred-soft-toe-024",
      ["all prior layers"],
      "final-frame",
    ),
  ],
};

describe("owner-bound WebGL2 render boundary", () => {
  it("implements measured shader inputs instead of no-op passes", () => {
    expect(
      shaderSources["lower-light-field-13tap"].match(/texture\(/g),
    ).toHaveLength(13);
    expect(shaderSources["dynamic-nonuniform-rim"]).toContain("framePhase");
    expect(shaderSources["owner-bloom-defocus"]).toContain("bloomAlpha");
    expect(shaderSources["owner-bloom-defocus"]).toContain("defocusAlpha");
    expect(shaderSources["display-referred-soft-toe-024"]).toContain(
      "toe = 0.24",
    );
  });
  it("consumes all declared passes with deterministic owner inputs", () => {
    const first = createRenderPlan(spec, scene, context, diagnostics);
    const second = createRenderPlan(
      { ...spec },
      { ...scene },
      context,
      diagnostics,
    );
    expect(first).toEqual(second);
    expect(first.residualOwner).toBe("residual");
    expect(first.layerOrder).toEqual(layers);
    expect(first.owners.map((owner) => owner.ownerId)).toEqual(["title", "ui"]);
    expect(first.contributions).toEqual(second.contributions);
  });

  it("keeps bloom and defocus independently ablatable", () => {
    const withoutBloom: SceneIR = {
      ...scene,
      effects: { ...scene.effects, title: { defocus: { measured: 2 } } },
    };
    expect(() =>
      createRenderPlan(spec, withoutBloom, context, diagnostics),
    ).toThrow("BLOOM_DEFOCUS_NOT_INDEPENDENT");
    expect(() =>
      createRenderPlan(
        spec,
        {
          ...scene,
          effects: {
            ...scene.effects,
            title: { bloom: { measured: 1 }, defocus: { measured: 1 } },
          },
        },
        context,
        diagnostics,
      ),
    ).not.toThrow();
  });

  it("fails closed for context, shader, pass, owner, and order violations", () => {
    expect(() => validateContext({ ...context, webgl2: false })).toThrow(
      "WEBGL2_REQUIRED",
    );
    expect(() =>
      validateContext({ ...context, premultipliedAlpha: true }),
    ).toThrow("PREMULTIPLIED_ALPHA_UNSUPPORTED");
    expect(() =>
      validateContext({ ...context, renderer: "webgl2", canvasFallback: true }),
    ).toThrow("WEBGL2_FALLBACK_REJECTED");
    expect(() =>
      validateContext({
        ...context,
        renderer: "webgl2",
        softwareRenderer: true,
      }),
    ).toThrow("WEBGL2_FALLBACK_REJECTED");
    expect(() =>
      validateShaderDiagnostics(
        diagnostics.map((item) =>
          item.shader === "dynamic-nonuniform-rim"
            ? { ...item, compiled: false, log: "compile error" }
            : item,
        ),
      ),
    ).toThrow("SHADER_COMPILE_FAILED");
    expect(() =>
      validateShaderDiagnostics(
        diagnostics.map((item) =>
          item.shader === "owner-bloom-defocus"
            ? { ...item, linked: false, log: "link error" }
            : item,
        ),
      ),
    ).toThrow("SHADER_LINK_FAILED");
    expect(() =>
      createRenderPlan(
        { ...spec, passList: [...spec.passList, spec.passList[0]!] },
        scene,
        context,
        diagnostics,
      ),
    ).toThrow("PASS_LIST_INVALID");
    expect(() =>
      createRenderPlan(
        {
          ...spec,
          passList: spec.passList.map((item, index) =>
            index === 1 ? { ...item, owner: "missing" } : item,
          ),
        },
        scene,
        context,
        diagnostics,
      ),
    ).toThrow("OWNER_INPUT_MISSING");
    expect(() =>
      createRenderPlan(
        { ...spec, layerOrder: [...layers].reverse() },
        scene,
        context,
        diagnostics,
      ),
    ).toThrow("LAYER_ORDER_INVALID");
    expect(() =>
      createRenderPlan(
        {
          ...spec,
          passList: spec.passList.map((item, index) =>
            item.passId === "treatment" ? { ...item, owner: "residual" } : item,
          ),
        },
        scene,
        context,
        diagnostics,
      ),
    ).toThrow("BLOOM_DEFOCUS_NOT_INDEPENDENT");
  });

  it("consumes residual gradient, light-pool, and sparkles measurements", () => {
    for (const [shader, input] of [
      ["residual-gradient", "residualCanvas.gradient mesh"],
      ["residual-light-pool", "residualCanvas.light pool"],
      ["residual-sparkles", "residualCanvas.sparkles"],
    ] as const) {
      const plan = createRenderPlan(spec, scene, context, diagnostics);
      expect(
        plan.contributions.find((item) =>
          spec.passList.some(
            (candidate) =>
              candidate.passId === item.passId && candidate.shader === shader,
          ),
        )?.inputs,
      ).toEqual([input]);
    }
  });

  it("rejects missing residual and behind/over inputs", () => {
    for (const measurement of [
      "gradient mesh",
      "light pool",
      "sparkles",
    ] as const) {
      const missingMeasurement = {
        ...scene,
        residualCanvas: {
          ...scene.residualCanvas,
          measurements: scene.residualCanvas.measurements.filter(
            (item) => item !== measurement,
          ),
        },
      };
      expect(() =>
        createRenderPlan(spec, missingMeasurement, context, diagnostics),
      ).toThrow(`RESIDUAL_INPUT_MISSING:${measurement}`);
    }
    expect(() =>
      createRenderPlan(
        {
          ...spec,
          passList: spec.passList.map((item) =>
            item.shader === "residual-gradient" ? { ...item, reads: [] } : item,
          ),
        },
        scene,
        context,
        diagnostics,
      ),
    ).toThrow("RESIDUAL_INPUT_MISSING:gradient mesh");
    expect(() =>
      createRenderPlan(
        {
          ...spec,
          passList: spec.passList.map((item) =>
            item.shader === "residual-gradient"
              ? { ...item, reads: ["wrong"] }
              : item,
          ),
        },
        scene,
        context,
        diagnostics,
      ),
    ).toThrow("RESIDUAL_INPUT_MISSING:gradient mesh");
    expect(() =>
      createRenderPlan(
        {
          ...spec,
          passList: spec.passList.map((item) =>
            item.passId === "lower-light-behind"
              ? { ...item, reads: [] }
              : item,
          ),
        },
        scene,
        context,
        diagnostics,
      ),
    ).toThrow("LOWER_LIGHT_INPUT_MISSING");
    expect(() =>
      createRenderPlan(spec, scene, context, diagnostics),
    ).not.toThrow();
    expect(() =>
      createRenderPlan(
        spec,
        { ...scene, residualCanvas: { ...scene.residualCanvas, owner: "ui" } },
        context,
        diagnostics,
      ),
    ).toThrow("RESIDUAL_OWNER_INVALID");
  });
});
