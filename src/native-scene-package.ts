import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SceneSpec } from "./contracts/index.js";
import type { RenderedFrame } from "./render-app/index.js";

type NativeScenePackageInput = Readonly<{
  directory: string;
  scene: SceneSpec;
  assetPaths: ReadonlyMap<string, string>;
  fontPath: string;
  frames: readonly RenderedFrame[];
  capability: Readonly<Record<string, boolean>>;
  verification: Readonly<Record<string, unknown>>;
}>;

export type NativeScenePackageResult = Readonly<{
  directory: string;
  manifestPath: string;
}>;

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const jsonBytes = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function buildNativeScenePackage(
  input: NativeScenePackageInput,
): Promise<NativeScenePackageResult> {
  const assetsDirectory = join(input.directory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const replacements = new Map<string, string>();
  const copiedAssets: Record<string, string> = {};
  for (const [assetId, sourcePath] of [...input.assetPaths].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const bytes = await readFile(sourcePath);
    const name = `${digest(bytes)}${extname(sourcePath).toLowerCase()}`;
    await cp(sourcePath, join(assetsDirectory, name));
    replacements.set(pathToFileURL(sourcePath).href, `assets/${name}`);
    copiedAssets[assetId] = `assets/${name}`;
  }
  const fontBytes = await readFile(input.fontPath);
  const fontName = `${digest(fontBytes)}${extname(input.fontPath).toLowerCase()}`;
  await cp(input.fontPath, join(assetsDirectory, fontName));

  const frames = input.frames.map((frame) => {
    let markup = frame.markup;
    for (const [source, target] of replacements)
      markup = markup.replaceAll(source, target);
    if (/\b(?:https?:|file:|\/\/)/iu.test(markup))
      throw new Error("SCENE_PACKAGE_EXTERNAL_URL");
    return { frame: frame.frame, markup };
  });
  const runtimeData = JSON.stringify({
    fps: input.scene.canvas.fps,
    frames,
  }).replaceAll("</script", "<\\/script");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>@font-face{font-family:RvsLocal;src:url("assets/${fontName}")}html,body,#scene{margin:0;width:100%;height:100%;overflow:hidden;background:${input.scene.palette.background}}body{font-family:RvsLocal,sans-serif}svg{width:100%;height:100%}</style></head>
<body><div id="scene"></div><script id="scene-data" type="application/json">${runtimeData}</script><script>
const data=JSON.parse(document.getElementById("scene-data").textContent);const scene=document.getElementById("scene");let start;
const draw=(now)=>{start??=now;const index=Math.min(data.frames.length-1,Math.floor((now-start)*data.fps/1000));scene.innerHTML=data.frames[index].markup;if(index<data.frames.length-1)requestAnimationFrame(draw)};requestAnimationFrame(draw);
</script></body></html>`;
  if (/\b(?:https?:|file:|\/\/)/iu.test(html))
    throw new Error("SCENE_PACKAGE_EXTERNAL_URL");

  const files = new Map<string, Uint8Array>([
    ["scene.json", jsonBytes(input.scene)],
    ["assets.json", jsonBytes(copiedAssets)],
    ["capability.json", jsonBytes(input.capability)],
    ["verification.json", jsonBytes(input.verification)],
    ["index.html", Buffer.from(html)],
  ]);
  for (const [path, bytes] of files) {
    await writeFile(join(input.directory, path), bytes);
  }
  const manifestFiles: Record<string, string> = {};
  for (const [path, bytes] of files) manifestFiles[path] = digest(bytes);
  manifestFiles[`assets/${fontName}`] = digest(fontBytes);
  for (const path of Object.values(copiedAssets))
    manifestFiles[path] = digest(await readFile(join(input.directory, path)));
  const manifestPath = join(input.directory, "manifest.json");
  await writeFile(
    manifestPath,
    jsonBytes({ schema: "rvs.native-scene-package.v1", files: manifestFiles }),
  );
  return { directory: input.directory, manifestPath };
}
