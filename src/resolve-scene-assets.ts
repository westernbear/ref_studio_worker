import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  planSceneAssets,
  SceneAssetError,
  type MaterialKind,
  type SceneSpec,
} from "./contracts/index.js";
import {
  isMaterialContentType,
  MaterialGenerationError,
  produceMaterial,
  unavailableMaterialProvider,
  type MaterialContentType,
  type MaterialProvenance,
  type MaterialProvider,
} from "./material-provider.js";

// Turns the `assets` phase's plan (planSceneAssets, in contracts) into real
// files in the lease workspace. This is the I/O half; the decision half is
// the pure planner, which is why nothing here branches on origin except to
// pick where the bytes come from.
export type ResolvedSceneAsset = Readonly<{
  assetId: string;
  kind: MaterialKind;
  path: string;
  contentType: MaterialContentType;
  sha256: string;
  // Null for an attachment-origin asset: its provenance is the upload
  // itself. Non-null for generated material, where it is what the spec
  // carries forward and validateSceneSpec demands.
  provenance: MaterialProvenance | null;
}>;

export type SceneAssetDependencies = Readonly<{
  downloadAttachment: (
    attachmentId: string,
    destinationPath: string,
    signal: AbortSignal,
  ) => Promise<{ readonly contentType: string }>;
  // Defaults to the fail-closed stub. A real provider is swapped in here
  // and nowhere else -- see material-provider.ts.
  provider?: MaterialProvider;
}>;

const EXTENSIONS: Readonly<Record<MaterialContentType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "font/otf": "otf",
  "font/ttf": "ttf",
  "font/woff2": "woff2",
};
const KIND_CONTENT_TYPES: Readonly<
  Record<MaterialKind, readonly MaterialContentType[]>
> = {
  image: ["image/png", "image/jpeg", "image/svg+xml"],
  video: ["video/mp4"],
  font: ["font/otf", "font/ttf", "font/woff2"],
};

// An asset id is the filename stem, so it must not be able to climb out of
// the assets directory. planSceneAssets already rejects duplicate ids, and
// SceneSpecSchema requires a non-empty string, but neither forbids a slash.
const SAFE_ASSET_ID = /^[A-Za-z0-9._-]+$/u;

const fileSha256 = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const checkedContentType = (
  assetId: string,
  kind: MaterialKind,
  contentType: string,
): MaterialContentType => {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!isMaterialContentType(normalized))
    throw new MaterialGenerationError(
      "ASSET_CONTENT_TYPE_INVALID",
      assetId,
      normalized,
    );
  if (!KIND_CONTENT_TYPES[kind].includes(normalized))
    throw new MaterialGenerationError(
      "ASSET_KIND_MISMATCH",
      assetId,
      `${kind} cannot be ${normalized}`,
    );
  return normalized;
};

export async function resolveSceneAssets(
  input: Readonly<{
    spec: SceneSpec;
    attachmentIds: readonly string[];
    workspace: string;
    signal: AbortSignal;
  }>,
  dependencies: SceneAssetDependencies,
): Promise<readonly ResolvedSceneAsset[]> {
  const plan = planSceneAssets(input.spec, {
    attachmentIds: input.attachmentIds,
  });
  if (plan.required.length === 0) return [];
  const provider = dependencies.provider ?? unavailableMaterialProvider;
  const directory = join(input.workspace, "scene-assets");
  await mkdir(directory, { recursive: true });
  const resolved: ResolvedSceneAsset[] = [];
  for (const required of plan.required) {
    if (!SAFE_ASSET_ID.test(required.assetId))
      throw new SceneAssetError("ASSET_ID_UNSAFE", required.assetId);
    const staging = join(directory, `${required.assetId}.part`);
    let contentType: MaterialContentType;
    let provenance: MaterialProvenance | null = null;
    if (required.source.origin === "attachment") {
      const downloaded = await dependencies.downloadAttachment(
        required.source.attachmentId,
        staging,
        input.signal,
      );
      contentType = checkedContentType(
        required.assetId,
        required.kind,
        downloaded.contentType,
      );
    } else {
      // The one call into the provider seam. It throws for every asset
      // today; that is the point -- an unavailable capability fails the
      // job, it never becomes a placeholder.
      const material = await produceMaterial(
        provider,
        {
          assetId: required.assetId,
          kind: required.kind,
          prompt: required.source.prompt,
          seed: required.source.seed,
          canvas: input.spec.canvas,
        },
        input.signal,
      );
      contentType = checkedContentType(
        required.assetId,
        required.kind,
        material.contentType,
      );
      provenance = material.provenance;
      await writeFile(staging, material.bytes, { mode: 0o600 });
    }
    const path = join(
      directory,
      `${required.assetId}.${EXTENSIONS[contentType]}`,
    );
    await rename(staging, path);
    resolved.push({
      assetId: required.assetId,
      kind: required.kind,
      path,
      contentType,
      sha256: await fileSha256(path),
      provenance,
    });
  }
  return resolved;
}
