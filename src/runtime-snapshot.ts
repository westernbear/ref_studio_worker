import { createHash } from "node:crypto";

export type RegisteredRuntimeSnapshot = Readonly<{
  schema: "rvs.worker-runtime.v1";
  chrome: Readonly<{ path: string; version: string; sha256: string }>;
  font: Readonly<{ path: string; version: string; sha256: string }>;
  ffmpeg: Readonly<{ path: string; version: string; sha256: string }>;
  ffprobe: Readonly<{ path: string; version: string; sha256: string }>;
  node: Readonly<{ path: string; version: string; sha256: string }>;
  renderer: string;
  imageDigest: string;
}>;

export const REGISTERED_RUNTIME: RegisteredRuntimeSnapshot = {
  schema: "rvs.worker-runtime.v1",
  chrome: {
    path: "/opt/chrome/chrome",
    version: "151.0.7922.138",
    sha256: "22f1017b80d5744b3ece65a585fcdd462fcbc487df57d211db39b44a4e9f948f",
  },
  font: {
    path: "/opt/rvs/fonts/WantedSansVariable.ttf",
    version: "1.0.3",
    sha256: "9953a7cfc4a3cba4ef1242abaf89779b3cd15fd9729c2d67d9e9d37a0da967f5",
  },
  ffmpeg: {
    path: "/opt/rvs/bin/ffmpeg",
    version: "8.0.1",
    sha256: "3194fc9e9febe3a85e491c38e176f524266b9cbb39f227a514229300f0181c4d",
  },
  ffprobe: {
    path: "/opt/rvs/bin/ffprobe",
    version: "8.0.1",
    sha256: "d88f63fd3896acf8a2713cab45cae428635ac40cbaccc67a61eec02dd4a1c5bf",
  },
  node: {
    path: "/usr/local/bin/node",
    version: "24.19.0",
    sha256: "bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12",
  },
  renderer:
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  imageDigest:
    "sha256:8404a853a499143346f188f5ebefea9e6131c6f59e41c7c2b13b8827ad30c5f0",
};

export const REGISTERED_RUNTIME_DIGEST = createHash("sha256")
  .update(JSON.stringify(REGISTERED_RUNTIME))
  .digest("hex");

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const runtimeSnapshotDigest = (
  snapshot: RegisteredRuntimeSnapshot,
): string =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

export const assertRuntimeIdentity = (
  actual: Readonly<{
    chromeVersion: string;
    chromeSha256: string;
    fontSha256: string;
    ffmpegVersion: string;
    ffmpegSha256: string;
    ffprobeVersion: string;
    ffprobeSha256: string;
    nodeVersion: string;
    nodeSha256: string;
    renderer?: string;
    imageDigest?: string;
  }>,
  registered: RegisteredRuntimeSnapshot = REGISTERED_RUNTIME,
): void => {
  if (
    actual.chromeVersion !== registered.chrome.version ||
    actual.chromeSha256 !== registered.chrome.sha256 ||
    actual.fontSha256 !== registered.font.sha256 ||
    actual.ffmpegVersion !== registered.ffmpeg.version ||
    actual.ffmpegSha256 !== registered.ffmpeg.sha256 ||
    actual.ffprobeVersion !== registered.ffprobe.version ||
    actual.ffprobeSha256 !== registered.ffprobe.sha256 ||
    actual.nodeVersion !== registered.node.version ||
    actual.nodeSha256 !== registered.node.sha256 ||
    (actual.renderer !== undefined &&
      actual.renderer !== registered.renderer) ||
    (actual.imageDigest !== undefined &&
      actual.imageDigest !== registered.imageDigest)
  )
    throw new Error("RUNTIME_SNAPSHOT_MISMATCH");
};
