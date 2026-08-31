import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REGISTERED_RUNTIME,
  type RegisteredRuntimeSnapshot,
} from "./runtime-snapshot.js";
import { runWorkerPreflight } from "./worker-preflight.js";

afterEach(() => vi.restoreAllMocks());

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const registeredFor = (
  overrides: Readonly<{
    chrome?: string;
    font?: string;
    ffmpeg?: string;
    ffprobe?: string;
    node?: string;
    renderer?: string;
  }> = {},
): RegisteredRuntimeSnapshot => ({
  ...REGISTERED_RUNTIME,
  chrome: {
    ...REGISTERED_RUNTIME.chrome,
    sha256: digest(overrides.chrome ?? "chrome-v1"),
  },
  font: {
    ...REGISTERED_RUNTIME.font,
    sha256: digest(overrides.font ?? "font-v1"),
  },
  ffmpeg: {
    ...REGISTERED_RUNTIME.ffmpeg,
    sha256: digest(overrides.ffmpeg ?? "ffmpeg-v1"),
  },
  ffprobe: {
    ...REGISTERED_RUNTIME.ffprobe,
    sha256: digest(overrides.ffprobe ?? "ffprobe-v1"),
  },
  node: {
    ...REGISTERED_RUNTIME.node,
    version: process.version.replace(/^v/u, ""),
    sha256: digest(overrides.node ?? "node-v1"),
  },
  renderer: overrides.renderer ?? "ANGLE SwiftShader",
});
const identityBytes = (
  path: string,
  overrides: Readonly<Record<string, string>> = {},
): Buffer => {
  if (path.includes("chrome"))
    return Buffer.from(overrides["chrome"] ?? "chrome-v1");
  if (
    path.toLowerCase().includes("font") ||
    path.toLowerCase().includes("wanted")
  )
    return Buffer.from(overrides["font"] ?? "font-v1");
  if (path.includes("ffprobe"))
    return Buffer.from(overrides["ffprobe"] ?? "ffprobe-v1");
  if (path.includes("ffmpeg"))
    return Buffer.from(overrides["ffmpeg"] ?? "ffmpeg-v1");
  if (path === process.execPath)
    return Buffer.from(overrides["node"] ?? "node-v1");
  return Buffer.from(overrides["modelManifest"] ?? "manifest-v1");
};

describe("worker runtime preflight", () => {
  it("fails closed before capture when the worker image digest is missing", async () => {
    let captured = false;
    await expect(
      runWorkerPreflight(new AbortController().signal, {
        runCommand: async (command) => ({
          stdout: command.includes("chrome")
            ? "Google Chrome 151.0.7922.138"
            : command.includes("ffprobe")
              ? "ffprobe version 8.0.1"
              : command.includes("ffmpeg")
                ? "ffmpeg version 8.0.1"
                : "ok",
          stderr: "",
        }),
        readIdentityFile: async (path: string) => identityBytes(path),
        registeredRuntime: registeredFor(),
        captureFrames: async () => {
          captured = true;
          throw new Error("CAPTURE_MUST_NOT_RUN");
        },
      }),
    ).rejects.toThrow("RUNTIME_SNAPSHOT_MISMATCH");
    expect(captured).toBe(false);
  });

  it.each(["invalid", `sha256:${"0".repeat(64)}`])(
    "fails closed before capture when the worker image digest is %s",
    async (declaredImageDigest) => {
      let captured = false;
      await expect(
        runWorkerPreflight(new AbortController().signal, {
          runCommand: async (command) => ({
            stdout: command.includes("chrome")
              ? "Google Chrome 151.0.7922.138"
              : command.includes("ffprobe")
                ? "ffprobe version 8.0.1"
                : command.includes("ffmpeg")
                  ? "ffmpeg version 8.0.1"
                  : "ok",
            stderr: "",
          }),
          readIdentityFile: async (path: string) => identityBytes(path),
          registeredRuntime: registeredFor(),
          declaredImageDigest,
          captureFrames: async () => {
            captured = true;
            throw new Error("CAPTURE_MUST_NOT_RUN");
          },
        }),
      ).rejects.toThrow("RUNTIME_SNAPSHOT_MISMATCH");
      expect(captured).toBe(false);
    },
  );

  it("fails closed before capture when the registered Wanted Sans bytes differ", async () => {
    let captured = false;
    await expect(
      runWorkerPreflight(new AbortController().signal, {
        runCommand: async (command) => ({
          stdout: command.includes("chrome")
            ? "Google Chrome 151.0.7922.138"
            : command.includes("ffprobe")
              ? "ffprobe version 8.0.1"
              : command.includes("ffmpeg")
                ? "ffmpeg version 8.0.1"
                : "ok",
          stderr: "",
        }),
        readIdentityFile: async (path: string) =>
          identityBytes(path, { font: "wrong-font" }),
        declaredImageDigest: REGISTERED_RUNTIME.imageDigest,
        captureFrames: async () => {
          captured = true;
          throw new Error("CAPTURE_MUST_NOT_RUN");
        },
      }),
    ).rejects.toThrow("RUNTIME_SNAPSHOT_MISMATCH");
    expect(captured).toBe(false);
  });

  it.each([
    ["Chrome", { chrome: "wrong-chrome" }],
    ["FFmpeg", { ffmpeg: "wrong-ffmpeg" }],
    ["ffprobe", { ffprobe: "wrong-ffprobe" }],
    ["Node", { node: "wrong-node" }],
  ])(
    "fails closed before capture when the registered %s bytes differ",
    async (_name, overrides) => {
      let captured = false;
      await expect(
        runWorkerPreflight(new AbortController().signal, {
          runCommand: async (command) => ({
            stdout: command.includes("chrome")
              ? "Google Chrome 151.0.7922.138"
              : command.includes("ffprobe")
                ? "ffprobe version 8.0.1"
                : command.includes("ffmpeg")
                  ? "ffmpeg version 8.0.1"
                  : "ok",
            stderr: "",
          }),
          readIdentityFile: async (path: string) =>
            identityBytes(path, overrides),
          registeredRuntime: registeredFor(),
          declaredImageDigest: REGISTERED_RUNTIME.imageDigest,
          captureFrames: async () => {
            captured = true;
            throw new Error("CAPTURE_MUST_NOT_RUN");
          },
        }),
      ).rejects.toThrow("RUNTIME_SNAPSHOT_MISMATCH");
      expect(captured).toBe(false);
    },
  );

  it("rejects an unregistered renderer before admission", async () => {
    await expect(
      runWorkerPreflight(new AbortController().signal, {
        runCommand: async (command) => ({
          stdout: command.includes("chrome")
            ? "Google Chrome 151.0.7922.138"
            : command.includes("ffprobe")
              ? "ffprobe version 8.0.1"
              : command.includes("ffmpeg")
                ? "ffmpeg version 8.0.1"
                : "ok",
          stderr: "",
        }),
        readIdentityFile: async (path: string) => identityBytes(path),
        registeredRuntime: registeredFor(),
        declaredImageDigest: REGISTERED_RUNTIME.imageDigest,
        captureFrames: async () => ({
          chromiumVersion: "151.0.7922.138",
          renderer: "ANGLE Hardware GPU",
          fontReady: true,
          webgl2: true,
          networkPolicy: "external-blocked",
          repeatedFrameByteIdentity: true,
          runtimeSnapshotDigest: "a".repeat(64),
          frameSha256: ["a".repeat(64)],
          passIds: [],
          shaderDiagnostics: [],
          limits: {},
        }),
      }),
    ).rejects.toThrow("RUNTIME_SNAPSHOT_MISMATCH");
  });

  it("checks the pinned tools and browser before returning PASS", async () => {
    const commands: string[] = [];
    const report = await runWorkerPreflight(new AbortController().signal, {
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        return {
          stdout: command.includes("chrome")
            ? "Google Chrome 151.0.7922.138"
            : command.includes("ffprobe")
              ? "ffprobe version 8.0.1"
              : command.includes("ffmpeg")
                ? "ffmpeg version 8.0.1"
                : "ok",
          stderr: "",
        };
      },
      captureFrames: async () => ({
        chromiumVersion: "151.0.7922.138",
        renderer: "ANGLE SwiftShader",
        fontReady: true,
        webgl2: true,
        networkPolicy: "external-blocked",
        repeatedFrameByteIdentity: true,
        frameSha256: ["a".repeat(64)],
        passIds: [],
        shaderDiagnostics: [],
        limits: {
          MAX_TEXTURE_SIZE: 16_384,
          MAX_RENDERBUFFER_SIZE: 16_384,
        },
      }),
      readIdentityFile: async (path: string) => identityBytes(path),
      registeredRuntime: registeredFor(),
      declaredImageDigest: REGISTERED_RUNTIME.imageDigest,
    });

    expect(report).toMatchObject({
      status: "PASS",
      chromiumVersion: "151.0.7922.138",
      renderer: "ANGLE SwiftShader",
      ffmpeg: true,
      ffprobe: true,
      tar: true,
      compilerModels: true,
    });
    expect(report.runtimeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(commands).toContain("tar --version");
    expect(commands).toHaveLength(5);
  });

  it("derives a deterministic digest from every runtime identity input", async () => {
    const digest = async (
      overrides: Readonly<{
        modelManifest?: string;
        font?: string;
        ffmpeg?: string;
        ffprobe?: string;
        tar?: string;
        rendererFrame?: string;
      }>,
    ): Promise<string> =>
      (
        await runWorkerPreflight(new AbortController().signal, {
          runCommand: async (command) => ({
            stdout: command.includes("chrome")
              ? "Google Chrome 151.0.7922.138"
              : command.includes("ffprobe")
                ? "ffprobe version 8.0.1"
                : command.includes("ffmpeg")
                  ? "ffmpeg version 8.0.1"
                  : command === "tar"
                    ? (overrides.tar ?? "tar-v1")
                    : "models-ok",
            stderr: "",
          }),
          captureFrames: async () => ({
            chromiumVersion: "151.0.7922.138",
            renderer: "ANGLE SwiftShader",
            fontReady: true,
            webgl2: true,
            networkPolicy: "external-blocked",
            repeatedFrameByteIdentity: true,
            frameSha256: [overrides.rendererFrame ?? "a".repeat(64)],
            passIds: [],
            shaderDiagnostics: [],
            limits: {
              MAX_TEXTURE_SIZE: 16_384,
              MAX_RENDERBUFFER_SIZE: 16_384,
            },
          }),
          readIdentityFile: async (path: string) =>
            identityBytes(path, overrides),
          registeredRuntime: registeredFor(overrides),
          declaredImageDigest: REGISTERED_RUNTIME.imageDigest,
        })
      ).runtimeDigest;

    const baseline = await digest({});
    expect(await digest({})).toBe(baseline);
    for (const changed of [
      { modelManifest: "manifest-v2" },
      { font: "font-v2" },
      { ffmpeg: "ffmpeg-v2" },
      { ffprobe: "ffprobe-v2" },
      { tar: "tar-v2" },
      { rendererFrame: "b".repeat(64) },
    ])
      expect(await digest(changed)).not.toBe(baseline);
  });

  it("passes the existing preflight deadline to browser capture", async () => {
    const deadline = new AbortController();
    deadline.abort(new Error("preflight deadline"));
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);

    await expect(
      runWorkerPreflight(new AbortController().signal, {
        runCommand: async (command) => ({
          stdout: command.includes("chrome")
            ? "Google Chrome 151.0.7922.138"
            : command.includes("ffprobe")
              ? "ffprobe version 8.0.1"
              : command.includes("ffmpeg")
                ? "ffmpeg version 8.0.1"
                : "ok",
          stderr: "",
        }),
        readIdentityFile: async (path: string) => identityBytes(path),
        registeredRuntime: registeredFor(),
        declaredImageDigest: REGISTERED_RUNTIME.imageDigest,
        captureFrames: async (input) => {
          if (input.signal.aborted) throw new Error("PREFLIGHT_TIMEOUT");
          throw new Error("BROWSER_CAPTURE_WAS_UNBOUNDED");
        },
      }),
    ).rejects.toThrow("PREFLIGHT_TIMEOUT");
    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("fails closed when the pinned font file is missing", async () => {
    await expect(
      runWorkerPreflight(new AbortController().signal, {
        runCommand: async () => ({ stdout: "151.0.7922.138", stderr: "" }),
        readIdentityFile: async (path: string) => {
          if (
            path.toLowerCase().includes("font") ||
            path.toLowerCase().includes("wanted")
          )
            throw new Error("ENOENT");
          return Buffer.from("manifest-v1");
        },
        captureFrames: async () => {
          throw new Error("must not capture without a verified font");
        },
        registeredRuntime: registeredFor(),
        declaredImageDigest: REGISTERED_RUNTIME.imageDigest,
      }),
    ).rejects.toThrow("ENOENT");
  });
});
