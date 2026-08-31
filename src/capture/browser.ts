import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { RenderedFrame } from "../render-app/index.js";
import type { BrowserPassSpec, SceneIR } from "../scene/compile.js";
import {
  PROCESS_TERMINATION_GRACE_MS,
  terminateProcess,
} from "../process-runner.js";
import {
  REGISTERED_RUNTIME,
  REGISTERED_RUNTIME_DIGEST,
  sha256,
} from "../runtime-snapshot.js";
import {
  createRenderPlan,
  SHADER_NAMES,
  shaderSources,
  validateContext,
  validateShaderDiagnostics,
  type ContextProbe,
  type ShaderDiagnostics,
} from "../render-app/webgl.js";

// allow: SIZE_OK - the deterministic renderer page is an inline data template.

const CHROMIUM_VERSION = "151.0.7922.138";
// The restore track's fixed product size, and the default the capture page
// takes when a render contract does not carry its own canvas ("preflight"
// and "workflow" -- see BrowserCaptureInput's renderContract union below).
// Only "generated" ever overrides this, with the canvas its own scene
// declared.
const VIEWPORT = { width: 1080, height: 1920 } as const;
type CanvasSize = Readonly<{ width: number; height: number }>;
const DevToolsTarget = z.object({ webSocketDebuggerUrl: z.string().url() });
const RuntimeProbe = z.object({
  frame: z.number().int().nonnegative(),
  fontReady: z.boolean(),
  webgl2: z.boolean(),
  renderer: z.string(),
  premultipliedAlpha: z.boolean(),
  colorSpace: z.enum(["srgb", "other"]),
  extensions: z.array(z.string()),
  limits: z.record(z.string(), z.number()),
  shaderDiagnostics: z.array(
    z.object({
      shader: z.enum(SHADER_NAMES),
      compiled: z.boolean(),
      linked: z.boolean(),
      log: z.string(),
    }),
  ),
  executedPasses: z.array(z.string()),
});
const ExceptionDetails = z
  .object({
    text: z.string().optional(),
    exception: z
      .object({ description: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

type CdpResponse = {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};
type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
};

export class CdpClient {
  readonly #socket: WebSocket;
  readonly #signal: AbortSignal;
  readonly #abort: () => void;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;

  private constructor(socket: WebSocket, signal: AbortSignal) {
    this.#socket = socket;
    this.#signal = signal;
    this.#abort = () => {
      this.#rejectPending(
        new Error("WORKER_JOB_CANCELLED", { cause: signal.reason }),
      );
      socket.close();
    };
    signal.addEventListener("abort", this.#abort, { once: true });
    if (signal.aborted) this.#abort();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(message.error.message ?? "CHROMIUM_CDP_FAILED"),
        );
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      signal.removeEventListener("abort", this.#abort);
      this.#rejectPending(new Error("CHROMIUM_CDP_CLOSED"));
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  static async connect(url: string, signal: AbortSignal): Promise<CdpClient> {
    if (signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener("abort", abort);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
      };
      const abort = (): void => {
        cleanup();
        socket.close();
        reject(new Error("WORKER_JOB_CANCELLED"));
      };
      const opened = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error("CHROMIUM_CDP_CONNECTION_FAILED"));
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
    });
    return new CdpClient(socket, signal);
  }

  async send<T>(method: string, params: object = {}): Promise<T> {
    if (this.#signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return (await response) as T;
  }

  close(): void {
    this.#signal.removeEventListener("abort", this.#abort);
    this.#rejectPending(new Error("CHROMIUM_CDP_CLOSED"));
    this.#socket.close();
  }
}

export type BrowserCaptureInput = Readonly<{
  workspace: string;
  framesDirectory: string;
  chromePath: string;
  fontPath: string;
  frames: readonly RenderedFrame[];
  // Required for "workflow" -- the measured lower-light field a WebGL2 pass
  // reads from. A "generated" or "preflight" contract has no measured
  // samples to offer, so this is optional for those and the page's own
  // 432-value guard is satisfied with zeros instead (see captureBrowserFrames).
  residualRgb16x9?: readonly (readonly number[])[];
  signal: AbortSignal;
  onFrame: (completed: number, total: number) => Promise<void>;
  renderContract:
    | Readonly<{ kind: "preflight" }>
    | Readonly<{
        kind: "workflow";
        browserPassSpec: BrowserPassSpec;
        scene: SceneIR;
      }>
    // Phase 2 generated-scene path (ruling 4): DOM/SVG only, no owner-bound
    // WebGL2 passes, so there is no BrowserPassSpec/SceneIR to carry. It
    // does carry the scene's own canvas, though: unlike the restore track
    // (always 1080x1920), a generated scene can be any of the three
    // declared aspects, and the capture page has to be sized to match.
    | Readonly<{ kind: "generated"; canvas: CanvasSize }>;
}>;

export type BrowserCaptureReport = Readonly<{
  chromiumVersion: string;
  renderer: string;
  fontReady: true;
  webgl2: true;
  networkPolicy: "external-blocked";
  repeatedFrameByteIdentity: true;
  runtimeSnapshotDigest: string;
  frameSha256: readonly string[];
  passIds: readonly string[];
  shaderDiagnostics: readonly ShaderDiagnostics[];
  limits: Readonly<Record<string, number>>;
}>;

const waitForFile = async (
  path: string,
  child: ChildProcess,
  signal: AbortSignal,
): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
    if (child.exitCode !== null) throw new Error("CHROMIUM_START_FAILED");
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("CHROMIUM_START_TIMEOUT");
};

export const renderPage = (
  fontPath: string,
  passList: readonly BrowserPassSpec["passList"][number][],
  canvas: CanvasSize = VIEWPORT,
): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    @font-face { font-family: RvsLocal; src: url(${JSON.stringify(pathToFileURL(fontPath).href)}); font-display: block; }
    * { box-sizing: border-box; }
    html, body { width: ${canvas.width}px; height: ${canvas.height}px; margin: 0; overflow: hidden; background: #050505; }
    body { font-family: RvsLocal, sans-serif; }
    canvas, #scene { position: absolute; inset: 0; width: ${canvas.width}px; height: ${canvas.height}px; }
    #background-effects { z-index: 0; }
    #scene { z-index: 1; }
    #owner-effects { z-index: 2; pointer-events: none; }
    #scene svg { width: ${canvas.width}px; height: ${canvas.height}px; overflow: hidden; }
    /* :where() keeps these at their original specificity, so the
       global-residual rule below still wins, while a measured fill="" from
       the renderer is no longer overridden by the stylesheet -- a CSS fill
       beats an SVG presentation attribute. */
    #scene text { font-family: RvsLocal, sans-serif; dominant-baseline: hanging; }
    /* Weight is a default, not a constant: an element that names its own
       font-weight wins over this -- the bundled Wanted Sans is a variable
       font spanning a 400-1000 weight axis, so a scene that wants hierarchy
       through weight contrast (not just size) can ask for it. A generated
       scene now does: SceneSpec's optional per-text-element "weight"
       (regular/bold/black) reaches this page as the mapped axis number on
       the <text> itself (render-app/generated.ts). 700 stays the default
       for text that names nothing, so a scene authored without a weight
       renders exactly as it always has. */
    #scene text:where(:not([font-weight])) { font-weight: 700; }
    #scene text:where(:not([fill])) { fill: #fff; }
    #scene rect { stroke-width: 3; rx: 28; }
    #scene rect:where(:not([stroke])) { stroke: rgba(255, 255, 255, .32); }
    #scene rect:where(:not([fill])) { fill: rgba(17, 17, 20, .82); }
    #scene [data-owner-id="global-residual"] { fill: transparent; stroke: none; }
  </style>
</head>
<body>
  <canvas id="background-effects" width="${canvas.width}" height="${canvas.height}"></canvas>
  <div id="scene"></div>
  <canvas id="owner-effects" width="${canvas.width}" height="${canvas.height}"></canvas>
  <script>
    const passList = ${JSON.stringify(passList)};
    const shaderSources = ${JSON.stringify(shaderSources)};
    const vertexSource = "#version 300 es\\nprecision highp float;\\nout vec2 uv;\\nvoid main(){vec2 position=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=position*0.5;gl_Position=vec4(position*2.0-1.0,0,1);}";
    const createRenderer = (canvas, alpha) => {
      const gl = canvas.getContext("webgl2", { alpha, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error("WEBGL2_REQUIRED");
      const compile = (kind, source) => {
        const shader = gl.createShader(kind);
        if (!shader) return { shader: null, compiled: false, log: "SHADER_CREATE_FAILED" };
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return {
          shader,
          compiled: Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
          log: gl.getShaderInfoLog(shader) || "",
        };
      };
      const vertex = compile(gl.VERTEX_SHADER, vertexSource);
      if (!vertex.compiled || !vertex.shader) throw new Error(vertex.log || "VERTEX_SHADER_COMPILE_FAILED");
      const programs = new Map();
      const diagnostics = [];
      for (const [name, source] of Object.entries(shaderSources)) {
        const fragment = compile(gl.FRAGMENT_SHADER, source);
        let linked = false;
        let log = fragment.log;
        if (fragment.compiled && fragment.shader) {
          const program = gl.createProgram();
          if (program) {
            gl.attachShader(program, vertex.shader);
            gl.attachShader(program, fragment.shader);
            gl.linkProgram(program);
            linked = Boolean(gl.getProgramParameter(program, gl.LINK_STATUS));
            log = [log, gl.getProgramInfoLog(program) || ""].filter(Boolean).join(" ");
            if (linked) programs.set(name, program);
          }
        }
        diagnostics.push({ shader: name, compiled: fragment.compiled, linked, log });
      }
      const texture = gl.createTexture();
      if (!texture) throw new Error("WEBGL_TEXTURE_CREATE_FAILED");
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.viewport(0, 0, ${canvas.width}, ${canvas.height});
      const clear = () => {
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, alpha ? 0 : 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      };
      const draw = (pass, frame, residualRgb, nodes) => {
        const program = programs.get(pass.shader);
        if (!program) throw new Error("SHADER_PROGRAM_UNAVAILABLE:" + pass.shader);
        const pixels = Uint8Array.from(residualRgb, value => Math.round(Math.max(0, Math.min(1, value)) * 255));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 16, 9, 0, gl.RGB, gl.UNSIGNED_BYTE, pixels);
        gl.useProgram(program);
        const residualLocation = gl.getUniformLocation(program, "residualField");
        if (residualLocation) gl.uniform1i(residualLocation, 0);
        const phaseLocation = gl.getUniformLocation(program, "framePhase");
        if (phaseLocation) gl.uniform1f(phaseLocation, frame);
        const allowedOwners = new Set(pass.owner.split(","));
        const selected = nodes.filter(node => allowedOwners.has(node.ownerId));
        if (selected.length > 32) throw new Error("OWNER_LIMIT_EXCEEDED");
        const bounds = new Float32Array(32 * 4);
        const effects = new Float32Array(32 * 4);
        selected.forEach((node, index) => {
          bounds.set([node.x, node.y, node.width, node.height], index * 4);
          effects.set([node.bloom, node.defocus, node.rim, 0], index * 4);
        });
        const countLocation = gl.getUniformLocation(program, "ownerCount");
        if (countLocation) gl.uniform1i(countLocation, selected.length);
        const boundsLocation = gl.getUniformLocation(program, "ownerBounds[0]");
        if (boundsLocation) gl.uniform4fv(boundsLocation, bounds);
        const effectsLocation = gl.getUniformLocation(program, "ownerEffects[0]");
        if (effectsLocation) gl.uniform4fv(effectsLocation, effects);
        if (pass.shader === "residual-gradient") gl.disable(gl.BLEND);
        else {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const attributes = gl.getContextAttributes();
      return {
        gl,
        clear,
        draw,
        diagnostics,
        context: {
          renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          premultipliedAlpha: Boolean(attributes && attributes.premultipliedAlpha),
          colorSpace: gl.drawingBufferColorSpace === "srgb" ? "srgb" : "other",
          extensions: gl.getSupportedExtensions() || [],
          limits: {
            MAX_TEXTURE_SIZE: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
            MAX_RENDERBUFFER_SIZE: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
          },
        },
      };
    };
    const background = createRenderer(document.getElementById("background-effects"), false);
    const overlay = createRenderer(document.getElementById("owner-effects"), true);
    if (overlay.diagnostics.some(item => !item.compiled || !item.linked)) throw new Error("OVERLAY_SHADER_PREFLIGHT_FAILED");
    window.renderFrame = async (frame, markup, residualRgb) => {
      if (!Array.isArray(residualRgb) || residualRgb.length !== 432) throw new Error("RESIDUAL_FIELD_INVALID");
      document.getElementById("scene").innerHTML = markup;
      const svg = document.querySelector("#scene svg");
      if (!svg) throw new Error("SEMANTIC_SCENE_MISSING");
      svg.setAttribute("viewBox", "0 0 ${canvas.width} ${canvas.height}");
      svg.setAttribute("width", "${canvas.width}");
      svg.setAttribute("height", "${canvas.height}");
      await document.fonts.ready;
      const nodes = Array.from(document.querySelectorAll("#scene [data-owner-id]")).map(element => ({
        ownerId: element.getAttribute("data-owner-id") || "",
        x: Number(element.getAttribute("x")),
        y: Number(element.getAttribute("y")),
        width: Number(element.getAttribute("width")),
        height: Number(element.getAttribute("height")),
        bloom: Number(element.getAttribute("data-bloom")),
        defocus: Number(element.getAttribute("data-defocus")),
        rim: Number(element.getAttribute("data-rim")),
      }));
      background.clear();
      overlay.clear();
      const executedPasses = [];
      for (const pass of passList) {
        if (pass.kind === "WebGL2") {
          const target = pass.writes === "background-layer" || pass.writes === "behind-ui-layer" ? background : overlay;
          target.draw(pass, frame, residualRgb, nodes);
        }
        executedPasses.push(pass.passId);
      }
      background.gl.finish();
      overlay.gl.finish();
      window.__rvsFrame = frame;
      return {
        frame: window.__rvsFrame,
        fontReady: document.fonts.status === "loaded",
        webgl2: true,
        ...background.context,
        shaderDiagnostics: background.diagnostics,
        executedPasses,
      };
    };
  </script>
</body>
</html>`;

const evaluate = async <T>(
  client: CdpClient,
  expression: string,
): Promise<T> => {
  const result = await client.send<{
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = ExceptionDetails.safeParse(result.exceptionDetails);
    const description = details.success
      ? (details.data.exception?.description ?? details.data.text)
      : undefined;
    throw new Error(
      `CHROMIUM_RENDER_FAILED${description ? `:${description.slice(0, 500)}` : ""}`,
    );
  }
  return result.result?.value as T;
};

const screenshot = async (client: CdpClient): Promise<Uint8Array> => {
  const result = await client.send<{ readonly data: string }>(
    "Page.captureScreenshot",
    { format: "png", fromSurface: true, captureBeyondViewport: false },
  );
  return Buffer.from(result.data, "base64");
};

const stopBrowser = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  const clearEscalation = terminateProcess(child);
  await Promise.race([
    exited,
    delay(PROCESS_TERMINATION_GRACE_MS * 2, undefined, { ref: false }),
  ]);
  clearEscalation();
};

export async function captureBrowserFrames(
  input: BrowserCaptureInput,
): Promise<BrowserCaptureReport> {
  const [chromeBytes, fontBytes] = await Promise.all([
    readFile(input.chromePath),
    readFile(input.fontPath),
  ]);
  if (
    sha256(chromeBytes) !== REGISTERED_RUNTIME.chrome.sha256 ||
    sha256(fontBytes) !== REGISTERED_RUNTIME.font.sha256
  )
    throw new Error("RUNTIME_SNAPSHOT_MISMATCH");
  // "workflow" must supply a measured field per frame, exactly as before.
  // "preflight"/"generated" have none to give -- default to zeros so the
  // capture page's unconditional 432-value guard (window.renderFrame) is
  // still satisfied even though no WebGL2 pass ever reads it for these
  // contracts (their passList is always []).
  const residualRgb16x9: readonly (readonly number[])[] =
    input.renderContract.kind === "workflow"
      ? (input.residualRgb16x9 ?? [])
      : (input.residualRgb16x9 ??
        input.frames.map(() => Array<number>(432).fill(0)));
  if (
    input.frames.length === 0 ||
    residualRgb16x9.length !== input.frames.length ||
    residualRgb16x9.some(
      (field) =>
        field.length !== 432 ||
        field.some(
          (value) => !Number.isFinite(value) || value < 0 || value > 1,
        ),
    )
  )
    throw new Error("RESIDUAL_FIELD_INVALID");
  await mkdir(input.framesDirectory, { recursive: true });
  const profile = join(input.workspace, "chrome-profile");
  const pagePath = join(input.workspace, "render.html");
  const passList =
    input.renderContract.kind === "workflow"
      ? input.renderContract.browserPassSpec.passList
      : [];
  // "preflight" and "workflow" (the restore track) stay pinned to the
  // portrait default -- only "generated" ever supplies a different canvas.
  const canvas: CanvasSize =
    input.renderContract.kind === "generated"
      ? input.renderContract.canvas
      : VIEWPORT;
  await mkdir(profile, { recursive: true });
  await writeFile(pagePath, renderPage(input.fontPath, passList, canvas), {
    mode: 0o600,
  });
  const child = spawn(
    input.chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-color-profile=srgb",
      "--lang=en-US",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) =>
      reject(new Error("CHROMIUM_START_FAILED", { cause: error })),
    );
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 65_536) stderr += chunk.toString();
  });
  const activePort = join(profile, "DevToolsActivePort");
  let client: CdpClient | undefined;
  try {
    await Promise.race([
      waitForFile(activePort, child, input.signal),
      spawnFailure,
    ]);
    const [port] = (await readFile(activePort, "utf8")).trim().split("\n");
    if (!port || !/^\d+$/.test(port)) throw new Error("CHROMIUM_PORT_INVALID");
    const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new`, {
      method: "PUT",
      signal: input.signal,
    });
    if (!targetResponse.ok) throw new Error("CHROMIUM_TARGET_FAILED");
    const target = DevToolsTarget.parse(await targetResponse.json());
    client = await CdpClient.connect(target.webSocketDebuggerUrl, input.signal);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Network.enable");
    await client.send("Network.setBlockedURLs", {
      urls: ["http://*", "https://*", "ftp://*"],
    });
    await client.send("Emulation.setDeviceMetricsOverride", {
      ...canvas,
      screenWidth: canvas.width,
      screenHeight: canvas.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Page.navigate", { url: pathToFileURL(pagePath).href });
    await evaluate(
      client,
      "document.readyState === 'complete' ? true : new Promise(resolve => addEventListener('load', () => resolve(true), { once: true }))",
    );
    const version = await client.send<{ readonly product: string }>(
      "Browser.getVersion",
    );
    const chromiumVersion = version.product.replace(/^Chrome\//, "");
    if (chromiumVersion !== CHROMIUM_VERSION)
      throw new Error("CHROMIUM_VERSION_MISMATCH");

    const hashes: string[] = [];
    let renderer = "";
    let shaderDiagnostics: readonly ShaderDiagnostics[] = [];
    let limits: Readonly<Record<string, number>> = {};
    let firstPng: Uint8Array | undefined;
    for (const [index, frame] of input.frames.entries()) {
      if (input.signal.aborted) throw new Error("WORKER_JOB_CANCELLED");
      const probe = RuntimeProbe.parse(
        await evaluate(
          client,
          `window.renderFrame(${frame.frame}, ${JSON.stringify(frame.markup)}, ${JSON.stringify(residualRgb16x9[index])})`,
        ),
      );
      if (
        probe.frame !== frame.frame ||
        !probe.fontReady ||
        !probe.webgl2 ||
        probe.renderer !== REGISTERED_RUNTIME.renderer
      )
        throw new Error("CHROMIUM_PREFLIGHT_FAILED");
      const context: ContextProbe = {
        webgl2: probe.webgl2,
        renderer: "webgl2",
        canvasFallback: false,
        softwareRenderer: false,
        premultipliedAlpha: probe.premultipliedAlpha,
        colorSpace: probe.colorSpace,
        extensions: probe.extensions,
        limits: probe.limits,
      };
      validateContext(context);
      validateShaderDiagnostics(probe.shaderDiagnostics);
      if (
        probe.executedPasses.length !== passList.length ||
        probe.executedPasses.some(
          (passId, passIndex) => passId !== passList[passIndex]?.passId,
        )
      )
        throw new Error("RENDER_PASS_EXECUTION_MISMATCH");
      if (index === 0) {
        if (input.renderContract.kind === "workflow")
          createRenderPlan(
            input.renderContract.browserPassSpec,
            input.renderContract.scene,
            context,
            probe.shaderDiagnostics,
          );
        shaderDiagnostics = probe.shaderDiagnostics;
        limits = probe.limits;
      } else if (
        JSON.stringify(probe.shaderDiagnostics) !==
          JSON.stringify(shaderDiagnostics) ||
        JSON.stringify(probe.limits) !== JSON.stringify(limits)
      )
        throw new Error("RUNTIME_PROBE_CHANGED");
      renderer ||= probe.renderer;
      const png = await screenshot(client);
      if (index === 0) firstPng = png;
      const path = join(
        input.framesDirectory,
        `frame-${String(index).padStart(6, "0")}.png`,
      );
      await writeFile(path, png, { mode: 0o600 });
      hashes.push(createHash("sha256").update(png).digest("hex"));
      await input.onFrame(index + 1, input.frames.length);
    }
    const first = input.frames[0];
    if (!first || !firstPng) throw new Error("RENDER_FRAMES_MISSING");
    await evaluate(
      client,
      `window.renderFrame(${first.frame}, ${JSON.stringify(first.markup)}, ${JSON.stringify(residualRgb16x9[0])})`,
    );
    const repeated = await screenshot(client);
    if (Buffer.compare(firstPng, repeated) !== 0)
      throw new Error("NONDETERMINISTIC_FRAME_BYTES");
    return {
      chromiumVersion,
      renderer,
      fontReady: true,
      webgl2: true,
      networkPolicy: "external-blocked",
      repeatedFrameByteIdentity: true,
      runtimeSnapshotDigest: REGISTERED_RUNTIME_DIGEST,
      frameSha256: hashes,
      passIds: passList.map((pass) => pass.passId),
      shaderDiagnostics,
      limits,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CHROMIUM"))
      console.error(
        JSON.stringify({
          event: "worker.chromium.failed",
          reason: error.message,
          executable: basename(input.chromePath),
          stderr: stderr.slice(-2_000),
        }),
      );
    throw error;
  } finally {
    client?.close();
    await stopBrowser(child);
  }
}
