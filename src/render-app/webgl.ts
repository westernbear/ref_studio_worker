import type { BrowserPassSpec, Pass, SceneIR } from "../scene/compile.js";

export const SHADER_CONTRACTS = {
  "dynamic-nonuniform-rim": {
    inputs: ["owner bounds", "edge-rim profile", "frame"],
    ownerBound: true,
  },
  "owner-bloom-defocus": {
    inputs: ["owner effect samples", "frame"],
    ownerBound: true,
  },
  "lower-light-field-13tap": {
    inputs: ["16x9 lower-light field", "owner occlusion", "frame"],
    paddingTexels: 3,
    ownerBound: false,
  },
  "residual-gradient": {
    inputs: ["residualCanvas.gradient mesh", "frame"],
    ownerBound: false,
  },
  "residual-light-pool": {
    inputs: ["residualCanvas.light pool", "frame"],
    ownerBound: false,
  },
  "residual-sparkles": {
    inputs: ["residualCanvas.sparkles", "frame"],
    ownerBound: false,
  },
  "display-referred-soft-toe-024": {
    inputs: ["composited color"],
    toe: 0.24,
    ownerBound: false,
  },
} as const;

export type ShaderName = keyof typeof SHADER_CONTRACTS;
export type ContextProbe = Readonly<{
  readonly webgl2: boolean;
  readonly renderer: "webgl2";
  readonly canvasFallback: boolean;
  readonly softwareRenderer: boolean;
  readonly premultipliedAlpha: boolean;
  readonly colorSpace: "srgb" | "other";
  readonly extensions: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}>;
export type ShaderDiagnostics = Readonly<{
  readonly shader: ShaderName;
  readonly compiled: boolean;
  readonly linked: boolean;
  readonly log: string;
}>;
export type RenderDiagnostics = Readonly<{
  readonly context: ContextProbe;
  readonly shaders: readonly ShaderDiagnostics[];
  readonly errors: readonly string[];
}>;
export type OwnerInput = Readonly<{
  readonly ownerId: string;
  readonly bounds: string;
  readonly effects: Readonly<Record<string, number>>;
}>;
export type Contribution = Readonly<{
  readonly passId: string;
  readonly owner: string;
  readonly writes: string;
  readonly inputs: readonly string[];
}>;
export type RenderPlan = Readonly<{
  readonly passes: readonly Pass[];
  readonly owners: readonly OwnerInput[];
  readonly residualOwner: string;
  readonly layerOrder: readonly string[];
  readonly contributions: readonly Contribution[];
  readonly diagnostics: RenderDiagnostics;
}>;

export const SHADER_NAMES = [
  "dynamic-nonuniform-rim",
  "owner-bloom-defocus",
  "lower-light-field-13tap",
  "residual-gradient",
  "residual-light-pool",
  "residual-sparkles",
  "display-referred-soft-toe-024",
] as const satisfies readonly ShaderName[];
const SHADER_SET: ReadonlySet<string> = new Set(SHADER_NAMES);
const REQUIRED_LAYERS = [
  "background-layer",
  "behind-ui-layer",
  "semantic-ui-layer",
  "copy-layer",
  "owner-treatment-layer",
  "over-ui-layer",
  "final-frame",
] as const;

export class WebGLRendererError extends Error {
  readonly token: string;
  constructor(token: string) {
    super(token);
    this.name = "WebGLRendererError";
    this.token = token;
  }
}

const fail = (token: string): never => {
  throw new WebGLRendererError(token);
};
const isShader = (shader: string | null): shader is ShaderName =>
  shader !== null && SHADER_SET.has(shader);
const passOwners = (pass: Pass): readonly string[] => pass.owner.split(",");

export function validateContext(context: ContextProbe): void {
  if (!context.webgl2) fail("WEBGL2_REQUIRED");
  if (
    context.renderer !== "webgl2" ||
    context.canvasFallback ||
    context.softwareRenderer
  )
    fail("WEBGL2_FALLBACK_REJECTED");
  if (context.premultipliedAlpha) fail("PREMULTIPLIED_ALPHA_UNSUPPORTED");
  if (context.colorSpace !== "srgb") fail("SRGB_REQUIRED");
  if (
    context.limits["MAX_TEXTURE_SIZE"] === undefined ||
    context.limits["MAX_TEXTURE_SIZE"] < 1920 ||
    context.limits["MAX_RENDERBUFFER_SIZE"] === undefined ||
    context.limits["MAX_RENDERBUFFER_SIZE"] < 1920
  )
    fail("WEBGL_LIMIT_TOO_LOW");
  if (!context.extensions.includes("EXT_color_buffer_float"))
    fail("WEBGL_EXTENSION_MISSING");
}

export function validateShaderDiagnostics(
  diagnostics: readonly ShaderDiagnostics[],
): void {
  for (const shader of SHADER_NAMES) {
    const result = diagnostics.find((entry) => entry.shader === shader);
    if (result === undefined) return fail("SHADER_DIAGNOSTICS_MISSING");
    if (!result.compiled) fail(`SHADER_COMPILE_FAILED:${shader}`);
    if (!result.linked) fail(`SHADER_LINK_FAILED:${shader}`);
  }
}

export function createRenderPlan(
  spec: BrowserPassSpec,
  scene: SceneIR,
  context: ContextProbe,
  shaderDiagnostics: readonly ShaderDiagnostics[],
): RenderPlan {
  validateContext(context);
  validateShaderDiagnostics(shaderDiagnostics);
  if (
    spec.layerOrder.length !== REQUIRED_LAYERS.length ||
    spec.layerOrder.some((layer, index) => layer !== REQUIRED_LAYERS[index])
  )
    fail("LAYER_ORDER_INVALID");
  const owners = new Map(scene.tracks.map((track) => [track.owner, track]));
  const residual = scene.residualCanvas.owner;
  const residualTrack = owners.get(residual);
  if (
    !residualTrack ||
    !scene.effects[residual] ||
    !scene.tracks.some(
      (track) =>
        track.owner === residual && track.effects.includes("residual-canvas"),
    )
  )
    fail("RESIDUAL_OWNER_INVALID");
  const residualMeasurements = new Set(scene.residualCanvas.measurements);
  for (const measurement of [
    "gradient mesh",
    "light pool",
    "sparkles",
  ] as const)
    if (!residualMeasurements.has(measurement))
      fail(`RESIDUAL_INPUT_MISSING:${measurement}`);
  if (
    spec.passList.length === 0 ||
    new Set(spec.passList.map((pass) => pass.passId)).size !==
      spec.passList.length
  )
    fail("PASS_LIST_INVALID");
  const inputs: OwnerInput[] = [];
  const domOwners = new Set<string>();
  const effectOwners = new Map<ShaderName, Set<string>>();
  let previousLayer = -1;
  for (const pass of spec.passList) {
    const layer = spec.layerOrder.indexOf(pass.writes);
    if (layer === -1) fail("PASS_LAYER_UNDECLARED");
    if (layer < previousLayer) fail("PASS_ORDER_MISMATCH");
    previousLayer = layer;
    for (const ownerId of passOwners(pass))
      if (!owners.has(ownerId)) fail("OWNER_INPUT_MISSING");
    if (pass.kind === "DOM/SVG")
      for (const ownerId of passOwners(pass)) domOwners.add(ownerId);
    const shader = pass.shader;
    if (shader !== null) {
      if (isShader(shader)) {
        const covered = effectOwners.get(shader) ?? new Set<string>();
        for (const ownerId of passOwners(pass)) covered.add(ownerId);
        effectOwners.set(shader, covered);
      } else fail("SHADER_CONTRACT_MISSING");
    }
    if (pass.shader === "owner-bloom-defocus") {
      for (const ownerId of passOwners(pass)) {
        const effects = scene.effects[ownerId];
        const bloom = effects?.["bloom"];
        const defocus = effects?.["defocus"];
        if (bloom === undefined || defocus === undefined)
          return fail("BLOOM_DEFOCUS_NOT_INDEPENDENT");
        if (
          typeof bloom !== "object" ||
          typeof defocus !== "object" ||
          bloom === null ||
          defocus === null ||
          bloom === defocus
        )
          fail("BLOOM_DEFOCUS_MERGED");
        inputs.push({
          ownerId,
          bounds: pass.reads.join("|"),
          effects: { bloom: 1, defocus: 1 },
        });
      }
    }
    if (pass.shader === "dynamic-nonuniform-rim")
      for (const ownerId of passOwners(pass))
        if (!scene.effects[ownerId]?.["rim"]) fail("RIM_INPUT_MISSING");
    if (
      pass.shader === "lower-light-field-13tap" &&
      !pass.reads.includes("residualCanvas.lower-light field")
    )
      fail("LOWER_LIGHT_INPUT_MISSING");
    if (
      pass.shader === "residual-gradient" &&
      !pass.reads.includes("residualCanvas.gradient mesh")
    )
      fail("RESIDUAL_INPUT_MISSING:gradient mesh");
    if (
      pass.shader === "residual-light-pool" &&
      !pass.reads.includes("residualCanvas.light pool")
    )
      fail("RESIDUAL_INPUT_MISSING:light pool");
    if (
      pass.shader === "residual-sparkles" &&
      !pass.reads.includes("residualCanvas.sparkles")
    )
      fail("RESIDUAL_INPUT_MISSING:sparkles");
    if (pass.reads.length === 0) fail("PASS_INPUT_MISSING");
  }
  for (const track of scene.tracks) {
    if (!domOwners.has(track.owner)) fail("DOM_PASS_MISSING");
    const effects = new Set(track.effects);
    if (effects.has("bloom") !== effects.has("defocus"))
      fail("BLOOM_DEFOCUS_NOT_INDEPENDENT");
    if (
      effects.has("bloom") &&
      !effectOwners.get("owner-bloom-defocus")?.has(track.owner)
    )
      fail("OWNER_TREATMENT_PASS_MISSING");
    if (
      effects.has("rim") &&
      !effectOwners.get("dynamic-nonuniform-rim")?.has(track.owner)
    )
      fail("RIM_PASS_MISSING");
  }
  for (const shader of [
    "residual-gradient",
    "residual-light-pool",
    "residual-sparkles",
    "display-referred-soft-toe-024",
  ] as const)
    if (!effectOwners.get(shader)?.has(residual))
      fail(`REQUIRED_PASS_MISSING:${shader}`);
  const lowerLightPasses = spec.passList.filter(
    (pass) => pass.shader === "lower-light-field-13tap",
  );
  if (
    !lowerLightPasses.some((pass) => pass.writes === "behind-ui-layer") ||
    !lowerLightPasses.some((pass) => pass.writes === "over-ui-layer")
  )
    fail("LOWER_LIGHT_OCCLUSION_PASSES_MISSING");
  if (spec.passList.at(-1)?.shader !== "display-referred-soft-toe-024")
    fail("FINAL_PASS_ORDER_INVALID");
  const contributions = spec.passList.map((pass) => ({
    passId: pass.passId,
    owner: pass.owner,
    writes: pass.writes,
    inputs: pass.reads,
  }));
  return {
    passes: spec.passList,
    owners: inputs,
    residualOwner: residual,
    layerOrder: spec.layerOrder,
    contributions,
    diagnostics: { context, shaders: shaderDiagnostics, errors: [] },
  };
}

// Measured owner effects are coverage fractions, not intensities: bloom is
// fraction(luma > 0.88) and rim is mean(canny)/255, so a clearly glowing card
// measures around 0.04. Multiplied straight into alpha that is a 1-3% no-op,
// which is why every glow pass rendered invisibly. Map the measured range onto
// 0..1 here, in the renderer, and leave the IR holding the honest measurement
// its `formulas` provenance describes.
const INTENSITY_GLSL = `float intensity(float measured) {
  return pow(clamp(measured / 0.15, 0.0, 1.0), 0.5);
}`;

export const shaderSources = {
  "dynamic-nonuniform-rim": `#version 300 es
precision highp float;
out vec4 outColor;
uniform int ownerCount;
uniform vec4 ownerBounds[32];
uniform vec4 ownerEffects[32];
uniform float framePhase;
${INTENSITY_GLSL}
void main() {
  vec2 point = vec2(gl_FragCoord.x, 1920.0 - gl_FragCoord.y);
  float alpha = 0.0;
  for (int index = 0; index < 32; index++) {
    if (index >= ownerCount) break;
    vec4 bounds = ownerBounds[index];
    vec2 delta = abs(point - (bounds.xy + bounds.zw * 0.5)) - bounds.zw * 0.5;
    float edge = abs(length(max(delta, 0.0)) + min(max(delta.x, delta.y), 0.0));
    float profile = 0.72 + 0.28 * sin(point.x * 0.021 + point.y * 0.013 + framePhase * 0.11 + float(index));
    alpha += exp(-edge * edge / 18.0) * intensity(ownerEffects[index].z) * profile * 0.7;
  }
  outColor = vec4(0.72, 0.9, 1.0, clamp(alpha, 0.0, 0.8));
}`,
  "owner-bloom-defocus": `#version 300 es
precision highp float;
out vec4 outColor;
uniform int ownerCount;
uniform vec4 ownerBounds[32];
uniform vec4 ownerEffects[32];
uniform float framePhase;
${INTENSITY_GLSL}
void main() {
  vec2 point = vec2(gl_FragCoord.x, 1920.0 - gl_FragCoord.y);
  float bloomAlpha = 0.0;
  float defocusAlpha = 0.0;
  for (int index = 0; index < 32; index++) {
    if (index >= ownerCount) break;
    vec4 bounds = ownerBounds[index];
    vec2 delta = abs(point - (bounds.xy + bounds.zw * 0.5)) - bounds.zw * 0.5;
    float outside = length(max(delta, 0.0));
    float pulse = 0.92 + 0.08 * sin(framePhase * 0.09 + float(index));
    float bloomRadius = 18.0 + ownerEffects[index].x * 18.0;
    float defocusRadius = 8.0 + ownerEffects[index].y * 42.0;
    bloomAlpha += exp(-(outside * outside) / (2.0 * bloomRadius * bloomRadius)) * intensity(ownerEffects[index].x) * pulse * 0.36;
    defocusAlpha += exp(-(outside * outside) / (2.0 * defocusRadius * defocusRadius)) * ownerEffects[index].y * 0.2;
  }
  float alpha = clamp(bloomAlpha + defocusAlpha, 0.0, 0.65);
  vec3 color = mix(vec3(0.44, 0.68, 1.0), vec3(0.76, 0.84, 1.0), defocusAlpha / max(alpha, 0.0001));
  outColor = vec4(color, alpha);
}`,
  "lower-light-field-13tap": `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
uniform sampler2D residualField;
void main() {
  vec2 point = vec2(uv.x, 1.0 - uv.y);
  vec2 texel = 1.0 / vec2(16.0, 9.0);
  vec3 color = texture(residualField, point).rgb * 4.0;
  color += texture(residualField, point + vec2(texel.x, 0.0)).rgb * 3.0;
  color += texture(residualField, point - vec2(texel.x, 0.0)).rgb * 3.0;
  color += texture(residualField, point + vec2(0.0, texel.y)).rgb * 3.0;
  color += texture(residualField, point - vec2(0.0, texel.y)).rgb * 3.0;
  color += texture(residualField, point + vec2(texel.x * 2.0, 0.0)).rgb * 2.0;
  color += texture(residualField, point - vec2(texel.x * 2.0, 0.0)).rgb * 2.0;
  color += texture(residualField, point + vec2(0.0, texel.y * 2.0)).rgb * 2.0;
  color += texture(residualField, point - vec2(0.0, texel.y * 2.0)).rgb * 2.0;
  color += texture(residualField, point + vec2(texel.x * 3.0, 0.0)).rgb;
  color += texture(residualField, point - vec2(texel.x * 3.0, 0.0)).rgb;
  color += texture(residualField, point + vec2(0.0, texel.y * 3.0)).rgb;
  color += texture(residualField, point - vec2(0.0, texel.y * 3.0)).rgb;
  color /= 28.0;
  outColor = vec4(color * 0.22, 0.12);
}`,
  "residual-gradient": `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
uniform sampler2D residualField;
void main() {
  outColor = vec4(texture(residualField, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0);
}`,
  "residual-light-pool": `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
void main() {
  float light = exp(-dot(uv - vec2(0.5, 0.72), uv - vec2(0.5, 0.72)) * 7.0);
  outColor = vec4(0.18, 0.26, 0.34, light * 0.16);
}`,
  "residual-sparkles": `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
uniform float framePhase;
float hash(vec2 value) {
  return fract(sin(dot(value, vec2(12.9898, 78.233)) + framePhase) * 43758.5453);
}
void main() {
  float sparkle = step(0.9985, hash(floor(gl_FragCoord.xy / 3.0)));
  outColor = vec4(vec3(0.92), sparkle * 0.22);
}`,
  "display-referred-soft-toe-024": `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
void main() {
  const float toe = 0.24;
  float vignette = smoothstep(0.85, 0.25, length(uv - 0.5));
  float toeWeight = toe / (1.0 + toe);
  outColor = vec4(0.0, 0.0, 0.0, (1.0 - vignette) * toeWeight * 0.12);
}`,
} as const satisfies Readonly<Record<ShaderName, string>>;
