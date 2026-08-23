import { createHash } from "node:crypto"
import { assertFrameReadBack, type RenderedFrame } from "../render-app/index.js"

export const CAPTURE_RUNTIME = {
  chromiumVersion: "151.0.7922.138",
  headless: true,
  gpu: true,
  angle: "swiftshader",
  backend: "OpenGL",
  deviceScaleFactor: 1,
  colorProfile: "srgb",
  locale: "en-US",
  timezone: "UTC",
  seed: "rvs-capture-seed-v1",
  origin: "http://127.0.0.1:4173",
} as const

export type CaptureRuntime = Readonly<typeof CAPTURE_RUNTIME>
export type RuntimeProbe = Readonly<{ readonly chromiumVersion: string; readonly backend: string; readonly headless: boolean; readonly gpu: boolean; readonly angle: string; readonly deviceScaleFactor: number; readonly colorProfile: string; readonly locale: string; readonly timezone: string; readonly seed: string; readonly origin: string }>
export type CaptureDiagnostics = Readonly<{ readonly runtime: RuntimeProbe; readonly fontReady: boolean; readonly modelReady: boolean; readonly webgl2: boolean; readonly shaderReady: boolean; readonly contextErrors: readonly string[]; readonly externalRequests: readonly string[]; readonly networkDenied: boolean }>
export type CaptureEvidence = Readonly<{ readonly requestedFrame: number; readonly readBackFrame: number; readonly runtime: RuntimeProbe; readonly fontReady: boolean; readonly modelReady: boolean; readonly webgl2: boolean; readonly shaderReady: boolean; readonly contextErrors: readonly string[]; readonly networkDenied: boolean; readonly pngSha256: string; readonly repeatedFrameByteIdentity: boolean }>
export type CaptureResult = Readonly<{ readonly png: Uint8Array; readonly evidence: CaptureEvidence }>

export class CapturePreflightError extends Error {
  readonly token: string
  constructor(token: string) { super(token); this.name = "CapturePreflightError"; this.token = token }
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const identity = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((value, index) => value === right[index])
const fail = (token: string): never => { throw new CapturePreflightError(token) }

export function validateCaptureRuntime(runtime: RuntimeProbe, expected: CaptureRuntime = CAPTURE_RUNTIME): void {
  if (runtime.chromiumVersion !== expected.chromiumVersion) fail("CHROMIUM_VERSION_MISMATCH")
  if (!runtime.headless || !runtime.gpu || runtime.angle !== expected.angle || runtime.backend !== expected.backend) fail("GPU_BACKEND_MISMATCH")
  if (runtime.deviceScaleFactor !== expected.deviceScaleFactor || runtime.colorProfile !== expected.colorProfile) fail("DISPLAY_CONFIGURATION_MISMATCH")
  if (runtime.locale !== expected.locale || runtime.timezone !== expected.timezone || runtime.seed !== expected.seed) fail("DETERMINISM_CONFIGURATION_MISMATCH")
  if (runtime.origin !== expected.origin || !runtime.origin.startsWith("http://127.0.0.1:")) fail("RENDER_ORIGIN_NOT_ALLOWLISTED")
}

export function validateCaptureDiagnostics(diagnostics: CaptureDiagnostics): void {
  validateCaptureRuntime(diagnostics.runtime)
  if (!diagnostics.fontReady) fail("FONT_PROBE_FAILED")
  if (!diagnostics.modelReady) fail("MODEL_PROBE_FAILED")
  if (!diagnostics.webgl2 || !diagnostics.shaderReady) fail("WEBGL_SHADER_PREFLIGHT_FAILED")
  if (diagnostics.contextErrors.length > 0) fail("CONTEXT_DIAGNOSTICS_FAILED")
  if (diagnostics.externalRequests.length > 0) fail("EXTERNAL_REQUEST_ATTEMPT")
  if (!diagnostics.networkDenied) fail("NETWORK_POLICY_UNPROVEN")
}

export type CaptureSource = Readonly<{ readonly renderFrame: (frame: number) => RenderedFrame; readonly capturePng: (frame: RenderedFrame) => Uint8Array; readonly readBack: (frame: RenderedFrame) => number }>

export function captureFrame(source: CaptureSource, diagnostics: CaptureDiagnostics, frame: number): CaptureResult {
  validateCaptureDiagnostics(diagnostics)
  const rendered = source.renderFrame(frame)
  assertFrameReadBack(rendered, frame)
  if (source.readBack(rendered) !== frame) fail("FRAME_READBACK_MISMATCH")
  const png = source.capturePng(rendered)
  const repeated = source.capturePng(source.renderFrame(frame))
  if (!identity(png, repeated)) fail("NONDETERMINISTIC_FRAME_BYTES")
  return { png, evidence: { requestedFrame: frame, readBackFrame: source.readBack(rendered), runtime: diagnostics.runtime, fontReady: diagnostics.fontReady, modelReady: diagnostics.modelReady, webgl2: diagnostics.webgl2, shaderReady: diagnostics.shaderReady, contextErrors: diagnostics.contextErrors, networkDenied: diagnostics.networkDenied, pngSha256: digest(png), repeatedFrameByteIdentity: true } }
}
