// Vendored from packages/contracts/src/canonical-json.ts — do not hand-edit.
// apps/worker is a standalone deployable (own Dockerfile/lockfile/workspace)
// and cannot depend on packages/contracts via "workspace:*" in a clean
// container build. This is a byte-for-byte copy of the pure module; the
// drift test in apps/api/src/worker-contracts-vendoring.test.ts is what
// keeps it honest -- if it fails, re-copy from packages/contracts/src.
// ---- vendored copy below, unmodified ----

import { createHash } from "node:crypto";

const isJsonObject = (
  value: unknown,
): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Canonical (key-sorted) JSON serialization: a digest computed from this is
// stable regardless of a JSON object's own property insertion order.
//
// This is the same ~10-line algorithm as apps/worker/src/scene/compile.ts's
// canonicalJson (the restore track's copy, which this package must not
// import from) and apps/worker/src/scene/spec-compile.ts's own duplicate of
// it (kept separate there for the same reason -- see that file's comment).
// It lives here too so apps/api -- which cannot import from the apps/worker
// submodule -- has a source for the identical algorithm: whole-branch
// review finding I3 was that apps/api/src/workers.ts digested a SceneSpec
// with plain `JSON.stringify` while apps/worker/src/gen-render-delivery.ts
// digests the same spec with `canonicalJson`, so the two digests of the
// same spec could never agree.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const sha256Hex = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
