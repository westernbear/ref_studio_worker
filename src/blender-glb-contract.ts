import { createHash } from "node:crypto";
import { z } from "zod";

export const BLENDER_3D_BUDGET = {
  maxTriangles: 250_000,
  maxMaterials: 64,
  maxTextureDimension: 4096,
  maxTextures: 32,
  maxBytes: 64 * 1024 * 1024,
} as const;

export type Blender3dBudget = Readonly<{
  maxTriangles: number;
  maxMaterials: number;
  maxTextureDimension: number;
  maxTextures: number;
  maxBytes: number;
}>;

export type ParsedGlbContract = Readonly<{
  triangles: number;
  materials: number;
  textures: number;
  textureSha256: readonly string[];
  sha256: string;
}>;

export class GlbContractError extends Error {
  readonly code: "GLB_CONTRACT_REJECTED" | "GLB_RESOURCE_BUDGET_EXCEEDED";

  constructor(code: GlbContractError["code"], detail: string) {
    super(`${code}:${detail}`);
    this.name = "GlbContractError";
    this.code = code;
  }
}

const IndexSchema = z.number().int().nonnegative();
const GlbJsonSchema = z
  .object({
    asset: z.object({ version: z.literal("2.0") }).passthrough(),
    accessors: z
      .array(z.object({ count: z.number().int().nonnegative() }).passthrough())
      .default([]),
    bufferViews: z
      .array(
        z
          .object({
            buffer: z.literal(0),
            byteOffset: z.number().int().nonnegative().default(0),
            byteLength: z.number().int().positive(),
          })
          .passthrough(),
      )
      .default([]),
    meshes: z
      .array(
        z
          .object({
            primitives: z.array(
              z
                .object({
                  mode: z.literal(4).default(4),
                  indices: IndexSchema.optional(),
                  attributes: z.object({ POSITION: IndexSchema }).passthrough(),
                })
                .strict(),
            ),
          })
          .passthrough(),
      )
      .default([]),
    materials: z.array(z.unknown()).default([]),
    images: z
      .array(
        z
          .object({
            bufferView: IndexSchema.optional(),
            mimeType: z.enum(["image/png", "image/jpeg"]).optional(),
            uri: z.string().optional(),
            extras: z
              .object({ rvsSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
              .strict()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
    extensionsUsed: z.array(z.string()).default([]),
  })
  .passthrough();

const ALLOWED_EXTENSIONS = new Set([
  "KHR_materials_unlit",
  "KHR_materials_transmission",
  "KHR_materials_ior",
  "KHR_texture_transform",
]);

type GlbChunks = Readonly<{ json: Uint8Array; binary: Uint8Array }>;

const readChunks = (bytes: Uint8Array): GlbChunks => {
  if (bytes.byteLength < 20)
    throw new GlbContractError("GLB_CONTRACT_REJECTED", "header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2)
    throw new GlbContractError("GLB_CONTRACT_REJECTED", "magic-or-version");
  if (view.getUint32(8, true) !== bytes.byteLength)
    throw new GlbContractError("GLB_CONTRACT_REJECTED", "length");
  let offset = 12;
  let json: Uint8Array | undefined;
  let binary: Uint8Array<ArrayBufferLike> = new Uint8Array();
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end > bytes.byteLength)
      throw new GlbContractError("GLB_CONTRACT_REJECTED", "chunk-length");
    if (type === 0x4e4f534a) json = bytes.subarray(offset + 8, end);
    if (type === 0x004e4942) binary = bytes.subarray(offset + 8, end);
    offset = end;
  }
  if (!json || offset !== bytes.byteLength)
    throw new GlbContractError("GLB_CONTRACT_REJECTED", "chunks");
  return { json, binary };
};

const embeddedTextureDimensions = (
  bytes: Uint8Array,
): Readonly<{ width: number; height: number }> => {
  if (
    bytes.length >= 24 &&
    Buffer.from(bytes.subarray(1, 4)).toString("ascii") === "PNG"
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3)
        return {
          height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
          width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
        };
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  throw new GlbContractError("GLB_CONTRACT_REJECTED", "texture-format");
};

export const parseGlbContract = (
  bytes: Uint8Array,
  budget: Blender3dBudget,
  localTextures: ReadonlyMap<string, Uint8Array> = new Map(),
): ParsedGlbContract => {
  if (
    [...localTextures.keys()].some(
      (path) => !/^assets\/[a-f0-9]{64}\.(?:png|jpe?g)$/u.test(path),
    )
  )
    throw new GlbContractError("GLB_CONTRACT_REJECTED", "local-texture-path");
  const totalBytes = [...localTextures.values()].reduce(
    (sum, texture) => sum + texture.byteLength,
    bytes.byteLength,
  );
  if (totalBytes > budget.maxBytes)
    throw new GlbContractError("GLB_RESOURCE_BUDGET_EXCEEDED", "bytes");
  const chunks = readChunks(bytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(chunks.json).trim());
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new GlbContractError("GLB_CONTRACT_REJECTED", "json");
    throw error;
  }
  const result = GlbJsonSchema.safeParse(decoded);
  if (!result.success)
    throw new GlbContractError("GLB_CONTRACT_REJECTED", "schema");
  const document = result.data;
  if (
    document.extensionsUsed.some(
      (extension) => !ALLOWED_EXTENSIONS.has(extension),
    )
  )
    throw new GlbContractError("GLB_CONTRACT_REJECTED", "extension");
  let triangles = 0;
  for (const mesh of document.meshes)
    for (const primitive of mesh.primitives) {
      const accessor =
        document.accessors[primitive.indices ?? primitive.attributes.POSITION];
      if (!accessor)
        throw new GlbContractError("GLB_CONTRACT_REJECTED", "accessor");
      triangles += Math.floor(accessor.count / 3);
    }
  if (
    triangles > budget.maxTriangles ||
    document.materials.length > budget.maxMaterials ||
    document.images.length > budget.maxTextures
  )
    throw new GlbContractError("GLB_RESOURCE_BUDGET_EXCEEDED", "scene");
  const textureSha256 = document.images.map((image) => {
    if (image.extras === undefined)
      throw new GlbContractError("GLB_CONTRACT_REJECTED", "texture-hash");
    let texture: Uint8Array;
    let uriDigest: string | undefined;
    if (image.uri !== undefined) {
      const uri = /^assets\/([a-f0-9]{64})\.(?:png|jpe?g)$/u.exec(image.uri);
      if (!uri)
        throw new GlbContractError("GLB_CONTRACT_REJECTED", "texture-uri");
      uriDigest = uri[1];
      const local = localTextures.get(image.uri);
      if (!local)
        throw new GlbContractError("GLB_CONTRACT_REJECTED", "texture-missing");
      texture = local;
    } else {
      if (image.bufferView === undefined || image.mimeType === undefined)
        throw new GlbContractError("GLB_CONTRACT_REJECTED", "texture-embedded");
      const bufferView = document.bufferViews[image.bufferView];
      if (
        !bufferView ||
        bufferView.byteOffset + bufferView.byteLength > chunks.binary.byteLength
      )
        throw new GlbContractError(
          "GLB_CONTRACT_REJECTED",
          "texture-buffer-view",
        );
      texture = chunks.binary.subarray(
        bufferView.byteOffset,
        bufferView.byteOffset + bufferView.byteLength,
      );
    }
    const digest = createHash("sha256").update(texture).digest("hex");
    if (
      digest !== image.extras.rvsSha256 ||
      (image.uri !== undefined && uriDigest !== digest)
    )
      throw new GlbContractError("GLB_CONTRACT_REJECTED", "texture-hash");
    const dimensions = embeddedTextureDimensions(texture);
    if (
      dimensions.width > budget.maxTextureDimension ||
      dimensions.height > budget.maxTextureDimension
    )
      throw new GlbContractError(
        "GLB_RESOURCE_BUDGET_EXCEEDED",
        "texture-dimensions",
      );
    return digest;
  });
  return {
    triangles,
    materials: document.materials.length,
    textures: document.images.length,
    textureSha256,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
