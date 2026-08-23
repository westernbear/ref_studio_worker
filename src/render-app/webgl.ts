import type { BrowserPassSpec, Pass, SceneIR } from "../scene/compile.js"

export const SHADER_CONTRACTS = {
  "dynamic-nonuniform-rim": { inputs: ["owner bounds", "edge-rim profile", "frame"], ownerBound: true },
  "owner-bloom-defocus": { inputs: ["owner effect samples", "frame"], ownerBound: true },
  "lower-light-field-13tap": { inputs: ["16x9 lower-light field", "owner occlusion", "frame"], paddingTexels: 3, ownerBound: false },
  "residual-gradient": { inputs: ["residualCanvas.gradient mesh", "frame"], ownerBound: false },
  "residual-light-pool": { inputs: ["residualCanvas.light pool", "frame"], ownerBound: false },
  "residual-sparkles": { inputs: ["residualCanvas.sparkles", "frame"], ownerBound: false },
  "display-referred-soft-toe-024": { inputs: ["composited color"], toe: 0.24, ownerBound: false },
} as const

export type ShaderName = keyof typeof SHADER_CONTRACTS
export type ContextProbe = Readonly<{
  readonly webgl2: boolean
  readonly renderer: "webgl2"
  readonly canvasFallback: boolean
  readonly softwareRenderer: boolean
  readonly premultipliedAlpha: boolean
  readonly colorSpace: "srgb" | "other"
  readonly extensions: readonly string[]
  readonly limits: Readonly<Record<string, number>>
}>
export type ShaderDiagnostics = Readonly<{ readonly shader: ShaderName; readonly compiled: boolean; readonly linked: boolean; readonly log: string }>
export type RenderDiagnostics = Readonly<{ readonly context: ContextProbe; readonly shaders: readonly ShaderDiagnostics[]; readonly errors: readonly string[] }>
export type OwnerInput = Readonly<{ readonly ownerId: string; readonly bounds: string; readonly effects: Readonly<Record<string, number>> }>
export type Contribution = Readonly<{ readonly passId: string; readonly owner: string; readonly writes: string; readonly inputs: readonly string[] }>
export type RenderPlan = Readonly<{ readonly passes: readonly Pass[]; readonly owners: readonly OwnerInput[]; readonly residualOwner: string; readonly layerOrder: readonly string[]; readonly contributions: readonly Contribution[]; readonly diagnostics: RenderDiagnostics }>

const REQUIRED_SHADERS = ["dynamic-nonuniform-rim", "owner-bloom-defocus", "lower-light-field-13tap", "residual-gradient", "residual-light-pool", "residual-sparkles", "display-referred-soft-toe-024"] as const satisfies readonly ShaderName[]
const SHADER_SET: ReadonlySet<string> = new Set(REQUIRED_SHADERS)
const REQUIRED_LAYERS = ["background-layer", "behind-ui-layer", "semantic-ui-layer", "copy-layer", "owner-treatment-layer", "over-ui-layer", "final-frame"] as const

export class WebGLRendererError extends Error {
  readonly token: string
  constructor(token: string) { super(token); this.name = "WebGLRendererError"; this.token = token }
}

const fail = (token: string): never => { throw new WebGLRendererError(token) }
const isShader = (shader: string | null): shader is ShaderName => shader !== null && SHADER_SET.has(shader)
const passOwners = (pass: Pass): readonly string[] => pass.owner.split(",")

export function validateContext(context: ContextProbe): void {
  if (!context.webgl2) fail("WEBGL2_REQUIRED")
  if (context.renderer !== "webgl2" || context.canvasFallback || context.softwareRenderer) fail("WEBGL2_FALLBACK_REJECTED")
  if (context.premultipliedAlpha) fail("PREMULTIPLIED_ALPHA_UNSUPPORTED")
  if (context.colorSpace !== "srgb") fail("SRGB_REQUIRED")
  if (context.limits["MAX_TEXTURE_SIZE"] === undefined || context.limits["MAX_TEXTURE_SIZE"] < 1080) fail("WEBGL_LIMIT_TOO_LOW")
  if (!context.extensions.includes("EXT_color_buffer_float")) fail("WEBGL_EXTENSION_MISSING")
}

export function validateShaderDiagnostics(diagnostics: readonly ShaderDiagnostics[]): void {
  for (const shader of REQUIRED_SHADERS) {
    const result = diagnostics.find((entry) => entry.shader === shader)
    if (result === undefined) return fail("SHADER_DIAGNOSTICS_MISSING")
    if (!result.compiled) fail(`SHADER_COMPILE_FAILED:${shader}`)
    if (!result.linked) fail(`SHADER_LINK_FAILED:${shader}`)
  }
}

export function createRenderPlan(spec: BrowserPassSpec, scene: SceneIR, context: ContextProbe, shaderDiagnostics: readonly ShaderDiagnostics[]): RenderPlan {
  validateContext(context)
  validateShaderDiagnostics(shaderDiagnostics)
  if (spec.layerOrder.length !== REQUIRED_LAYERS.length || spec.layerOrder.some((layer, index) => layer !== REQUIRED_LAYERS[index])) fail("LAYER_ORDER_INVALID")
  const owners = new Map(scene.tracks.map((track) => [track.owner, track]))
  const residual = scene.residualCanvas.owner
  const residualTrack = owners.get(residual)
  if (!residualTrack || !scene.effects[residual] || !scene.tracks.some((track) => track.owner === residual && track.effects.includes("residual-canvas"))) fail("RESIDUAL_OWNER_INVALID")
  const residualMeasurements = new Set(scene.residualCanvas.measurements)
  for (const measurement of ["gradient mesh", "light pool", "sparkles"] as const) if (!residualMeasurements.has(measurement)) fail(`RESIDUAL_INPUT_MISSING:${measurement}`)
  if (spec.passList.length !== 9) fail("PASS_LIST_INVALID")
  const inputs: OwnerInput[] = []
  for (const pass of spec.passList) {
    if (!spec.layerOrder.includes(pass.writes)) fail("PASS_LAYER_UNDECLARED")
    for (const ownerId of passOwners(pass)) if (!owners.has(ownerId)) fail("OWNER_INPUT_MISSING")
    if (pass.shader !== null && !isShader(pass.shader)) fail("SHADER_CONTRACT_MISSING")
    if (pass.shader === "owner-bloom-defocus") {
      for (const ownerId of passOwners(pass)) {
        const effects = scene.effects[ownerId]
        const bloom = effects?.["bloom"]
        const defocus = effects?.["defocus"]
        if (bloom === undefined || defocus === undefined) return fail("BLOOM_DEFOCUS_NOT_INDEPENDENT")
        if (typeof bloom !== "object" || typeof defocus !== "object" || bloom === null || defocus === null || bloom === defocus) fail("BLOOM_DEFOCUS_MERGED")
        inputs.push({ ownerId, bounds: pass.reads.join("|"), effects: { bloom: 1, defocus: 1 } })
      }
    }
    if (pass.shader === "dynamic-nonuniform-rim") for (const ownerId of passOwners(pass)) if (!scene.effects[ownerId]?.["rim"]) fail("RIM_INPUT_MISSING")
    if (pass.shader === "lower-light-field-13tap" && !pass.reads.includes("residualCanvas.lower-light field")) fail("LOWER_LIGHT_INPUT_MISSING")
    if (pass.shader === "residual-gradient" && !pass.reads.includes("residualCanvas.gradient mesh")) fail("RESIDUAL_INPUT_MISSING:gradient mesh")
    if (pass.shader === "residual-light-pool" && !pass.reads.includes("residualCanvas.light pool")) fail("RESIDUAL_INPUT_MISSING:light pool")
    if (pass.shader === "residual-sparkles" && !pass.reads.includes("residualCanvas.sparkles")) fail("RESIDUAL_INPUT_MISSING:sparkles")
    if (pass.reads.length === 0) fail("PASS_INPUT_MISSING")
  }
  const ordered = spec.passList.map((pass) => pass.writes)
  if (ordered.indexOf("behind-ui-layer") > ordered.indexOf("semantic-ui-layer") || ordered.indexOf("over-ui-layer") < ordered.indexOf("semantic-ui-layer")) fail("OCCLUSION_ORDER_INVALID")
  const contributions = spec.passList.map((pass) => ({ passId: pass.passId, owner: pass.owner, writes: pass.writes, inputs: pass.reads }))
  return { passes: spec.passList, owners: inputs, residualOwner: residual, layerOrder: spec.layerOrder, contributions, diagnostics: { context, shaders: shaderDiagnostics, errors: [] } }
}

export const shaderSources = {
  "dynamic-nonuniform-rim": "#version 300 es\nprecision highp float;\nvoid main(){ }",
  "owner-bloom-defocus": "#version 300 es\nprecision highp float;\nvoid main(){ }",
  "lower-light-field-13tap": "#version 300 es\nprecision highp float;\nvoid main(){ }",
  "residual-gradient": "#version 300 es\nprecision highp float;\nvoid main(){ }",
  "residual-light-pool": "#version 300 es\nprecision highp float;\nvoid main(){ }",
  "residual-sparkles": "#version 300 es\nprecision highp float;\nvoid main(){ }",
  "display-referred-soft-toe-024": "#version 300 es\nprecision highp float;\nvoid main(){ }",
} as const satisfies Readonly<Record<ShaderName, string>>
