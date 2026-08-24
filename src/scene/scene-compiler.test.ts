import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  compileScene,
  type EvidenceInput,
  type Pass,
  type Track,
} from "./compile.js";

const titleTrack: Track = {
  trackId: "title-track",
  owner: "title",
  lifecycle: {
    enter: { start: 0 },
    stable: { start: 1 },
    exit: { start: 120 },
  },
  geometryRef: "title",
  effects: ["bloom"],
};
const residualTrack: Track = {
  trackId: "residual-track",
  owner: "residual",
  lifecycle: {
    enter: { start: 0 },
    stable: { start: 1 },
    exit: { start: 120 },
  },
  geometryRef: "residual",
  effects: ["residual-canvas"],
};
const titlePass: Pass = {
  passId: "title-pass",
  owner: "title",
  kind: "DOM/SVG",
  shader: null,
  reads: ["font"],
  writes: "copy-layer",
};
const residualPass: Pass = {
  passId: "residual-pass",
  owner: "residual",
  kind: "WebGL2",
  shader: "lower-light",
  reads: ["residual"],
  writes: "background-layer",
};
const cue = {
  anchorId: "cue",
  frame: 30,
  sample: 48000,
  owner: "title",
  role: "entry",
  confidence: 0.5,
} as const;
const residualGeometry = {
  boundsPerFrame: [{ frame: 0, x: 0, y: 0, width: 1080, height: 1920 }],
  fixedWidth: true,
  fixedX: true,
} as const;

const base: EvidenceInput = {
  tenantId: "ten_fixture",
  editor: "usr_editor",
  reason: "T24",
  timestamp: "2026-08-22T00:00:00.000Z",
  gate: "APPROVED",
  owners: [
    {
      ownerId: "title",
      kind: "text-word",
      editable: true,
      assetRef: "font",
      confidence: 0.9,
      content: "분석",
    },
    {
      ownerId: "residual",
      kind: "global-residual",
      editable: true,
      assetRef: "background",
      confidence: 0.82,
    },
  ],
  editableAssets: [
    { assetId: "font", kind: "font", editable: true, owner: "title" },
    {
      assetId: "background",
      kind: "background-material",
      editable: true,
      owner: "residual",
    },
  ],
  geometry: {
    title: {
      boundsPerFrame: [{ frame: 0, x: 1, y: 2, width: 3, height: 4 }],
      fixedWidth: true,
      fixedX: true,
    },
    residual: residualGeometry,
  },
  tracks: [titleTrack, residualTrack],
  effects: { title: { bloom: { unit: "intensity", source: "T22" } } },
  residualCanvas: {
    owner: "residual",
    measurements: ["gradient mesh"],
    mustRemainSeparate: true,
    compositeRule: "before owner effects",
  },
  audio: { sampleRateHz: 48000, channels: 2, anchors: [cue] },
  passes: [titlePass, residualPass],
  layerOrder: ["background-layer", "copy-layer"],
  allowedShaders: ["lower-light"],
};

describe("scene compiler", () => {
  it("round-trips deterministic digest-linked IR", () => {
    const first = compileScene(base);
    const second = compileScene({ ...base });
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.scene.parentDigest).toBe(first.authoring.digest);
    expect(first.browserPassSpec.parentDigest).toBe(first.scene.digest);
    expect(first.browserPassSpec.previewDigest).toBe(first.scene.digest);
  });

  const replace = (
    change: (input: EvidenceInput) => EvidenceInput,
  ): EvidenceInput => change(base);
  const cases: readonly (readonly [string, EvidenceInput, string])[] = [
    [
      "absent owner",
      replace((input) => ({
        ...input,
        tracks: [{ ...titleTrack, owner: "missing" }, residualTrack],
      })),
      "OWNER_MISMATCH",
    ],
    [
      "unresolved choice",
      replace((input) => ({ ...input, needsChoice: [{ reason: "choice" }] })),
      "UNRESOLVED_CHOICE",
    ],
    [
      "invented geometry",
      replace((input) => ({
        ...input,
        tracks: [{ ...titleTrack, geometryRef: "invented" }, residualTrack],
      })),
      "INVENTED_GEOMETRY",
    ],
    [
      "swapped pass",
      replace((input) => ({
        ...input,
        passes: [{ ...titlePass, owner: "missing" }, residualPass],
      })),
      "OWNER_MISMATCH",
    ],
    [
      "removed residual",
      replace((input) => ({
        ...input,
        residualCanvas: { ...input.residualCanvas, mustRemainSeparate: false },
      })),
      "RESIDUAL_SEPARATION",
    ],
    [
      "invalid audio rate",
      replace((input) => ({
        ...input,
        audio: { ...input.audio, sampleRateHz: 44100 },
      })),
      "INVALID_AUDIO_RATE",
    ],
    [
      "unapproved gate",
      replace((input) => ({ ...input, gate: "PENDING" })),
      "UNAPPROVED_GATE",
    ],
    [
      "unconsumed effect",
      replace((input) => ({
        ...input,
        effects: {
          ...input.effects,
          title: {
            ...input.effects["title"],
            defocus: { unit: "px", source: "T22" },
          },
        },
      })),
      "UNCONSUMED_EFFECT",
    ],
    [
      "shader allowlist",
      replace((input) => ({
        ...input,
        passes: [{ ...residualPass, shader: "not-allowed" }, titlePass],
      })),
      "SHADER_NOT_ALLOWLISTED",
    ],
    [
      "invalid audio mapping",
      replace((input) => ({
        ...input,
        audio: { ...input.audio, anchors: [{ ...cue, sample: 48001 }] },
      })),
      "INVALID_AUDIO_MAPPING",
    ],
    [
      "pass order",
      replace((input) => ({
        ...input,
        passes: [{ ...titlePass, writes: "missing-layer" }, residualPass],
      })),
      "PASS_ORDER_MISMATCH",
    ],
    [
      "unbound effect",
      replace((input) => ({
        ...input,
        tracks: [
          { ...titleTrack, effects: ["bloom", "rim"] },
          { ...residualTrack, effects: ["residual-canvas", "rim"] },
        ],
        effects: {
          title: { bloom: { unit: "intensity", source: "T22" } },
          residual: { rim: { unit: "normalized", source: "T22" } },
        },
      })),
      "UNBOUND_EFFECT",
    ],
    [
      "missing measured geometry",
      replace((input) => ({
        ...input,
        geometry: { residual: input.geometry["residual"] ?? residualGeometry },
      })),
      "MISSING_MEASURED_GEOMETRY",
    ],
    [
      "invalid lifecycle",
      replace((input) => ({
        ...input,
        tracks: [
          { ...titleTrack, lifecycle: { enter: {}, stable: {} } },
          residualTrack,
        ],
      })),
      "INVALID_LIFECYCLE",
    ],
  ];
  for (const [name, input, token] of cases)
    it(`rejects ${name}`, () =>
      expect(() => compileScene(input)).toThrow(token));

  it("compiles a pending scene only for preview", () => {
    const pending = {
      ...base,
      gate: "PENDING" as const,
      needsChoice: [{ choiceId: "choice_foreground_subject" }],
    };
    expect(compileScene(pending, true).scene.schema).toBe("scene-ir-v1");
    expect(() => compileScene(pending)).toThrow("UNAPPROVED_GATE");
  });

  it("matches the standalone semantic contract fixture", async () => {
    const golden = await import("./fixtures/editable-scene-contract.json", {
      with: { type: "json" },
    });
    const contract = golden.default;
    expect(contract.AuthoringIR.schema).toBe("authoring-ir-v1");
    expect(contract.SceneIR.schema).toBe("scene-ir-v1");
    expect(contract.BrowserPassSpec.schema).toBe("browser-pass-spec-v1");
    const compiled = compileScene(base);
    expect(compiled.authoring.schema).toBe(contract.AuthoringIR.schema);
    expect(compiled.scene.schema).toBe(contract.SceneIR.schema);
    expect(compiled.browserPassSpec.schema).toBe(
      contract.BrowserPassSpec.schema,
    );
    expect(compiled.scene.audio.sampleRateHz).toBe(
      contract.SceneIR.audio.sampleRateHz,
    );
    expect(compiled.scene.audio.channels).toBe(contract.SceneIR.audio.channels);
    expect(compiled.browserPassSpec.layerOrder).toContain("copy-layer");
  });
});
