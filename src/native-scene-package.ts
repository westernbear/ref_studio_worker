import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { extname, join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { SceneSpec } from "./contracts/index.js";
import type { RenderedFrame } from "./render-app/index.js";
import { REGISTERED_RUNTIME_DIGEST } from "./runtime-snapshot.js";
import { createNativeInteractionModel } from "./scene-interactions.js";

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

type ManifestFile = Readonly<{ path: string; sha256: string; bytes: number }>;
type ManifestV2 = Readonly<{
  schema: "rvs.native-scene-package.v2";
  sceneDigest: string;
  runtimeFingerprint: string;
  registeredRuntimeDigest: string;
  creationPolicy: Readonly<{
    assets: "sha256-named";
    externalUrls: "forbidden";
    generatedAt: "omitted-for-reproducibility";
  }>;
  files: readonly ManifestFile[];
}>;

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const SAFE_PATH =
  /^(?:assets\/[a-f0-9]{64}\.[a-z0-9]{1,10}|reports\/(?:capability|verification)\.json|(?:scene|assets|capability|verification)\.json|index\.html)$/u;
const UNSAFE_CONTENT =
  /(?:\bon[a-z]+\s*=|\beval\s*\(|@import\b|\bsrcset\s*=|\bimage-set\s*\(|\burl\s*\()/iu;
const HASH_ASSET = /^assets\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/u;
const STATIC_TAGS = new Set(["svg", "g", "rect", "text", "image"]);
const COMMON_DRAW_ATTRIBUTES = new Set([
  "id",
  "data-element-id",
  "data-asset-ref",
  "data-owner-id",
  "data-editable",
  "data-bloom",
  "data-defocus",
  "data-rim",
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "transform",
  "fill",
  "stroke",
]);
const ATTRIBUTES_BY_TAG: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(["data-frame", "role", "xmlns"]),
  g: new Set(["data-layer-order"]),
  rect: new Set([...COMMON_DRAW_ATTRIBUTES, "style"]),
  text: new Set([
    ...COMMON_DRAW_ATTRIBUTES,
    "font-size",
    "font-weight",
    "textLength",
    "lengthAdjust",
  ]),
  image: new Set([...COMMON_DRAW_ATTRIBUTES, "href", "preserveAspectRatio"]),
};
const TAG = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/gu;
const ATTRIBUTE =
  /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;

const safeExtension = (path: string): string => {
  const extension = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : ".bin";
};
const assertRegularFile = async (path: string): Promise<void> => {
  if (!(await lstat(path)).isFile())
    throw new Error("SCENE_PACKAGE_UNSAFE_PATH");
};
const assertSafeMarkup = (
  markup: string,
  packagedAssets: ReadonlySet<string>,
): void => {
  if (UNSAFE_CONTENT.test(markup))
    throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
  const allowedResource = (value: string): boolean =>
    /^#[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(value) ||
    (HASH_ASSET.test(value) && packagedAssets.has(value));
  const stack: string[] = [];
  let roots = 0;
  for (const match of markup.matchAll(TAG)) {
    const closing = match[1] === "/";
    const tag = match[2] ?? "";
    if (!STATIC_TAGS.has(tag)) throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
    if (closing) {
      if ((match[3] ?? "").trim() !== "" || stack.pop() !== tag)
        throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
      continue;
    }
    if (stack.length === 0) {
      roots += 1;
      if (tag !== "svg") throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
    }
    const rawAttributes = match[3] ?? "";
    const selfClosing = /\/\s*$/u.test(rawAttributes);
    const remainder = rawAttributes
      .replace(ATTRIBUTE, "")
      .replace(/\/\s*$/u, "");
    if (remainder.trim() !== "")
      throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
    const seen = new Set<string>();
    for (const attribute of rawAttributes.matchAll(ATTRIBUTE)) {
      const name = attribute[1] ?? "";
      const value = attribute[2] ?? attribute[3] ?? "";
      if (seen.has(name) || !ATTRIBUTES_BY_TAG[tag]?.has(name))
        throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
      seen.add(name);
      if (name === "href" && !allowedResource(value))
        throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
      if (name === "style" && value !== "rx:0")
        throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
      if (name === "xmlns" && value !== "http://www.w3.org/2000/svg")
        throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
    }
    if (!selfClosing) stack.push(tag);
  }
  if (
    roots !== 1 ||
    stack.length !== 0 ||
    markup.replace(TAG, "").includes("<")
  )
    throw new Error("SCENE_PACKAGE_UNSAFE_CONTENT");
};

const RUNTIME_SCRIPT = `
const data=JSON.parse(document.getElementById("scene-data").textContent),scene=document.getElementById("scene"),play=document.getElementById("play-pause"),scrub=document.getElementById("frame-scrub"),number=document.getElementById("frame-number"),reduced=matchMedia("(prefers-reduced-motion: reduce)");let frame=0,playing=false,last=0,state=structuredClone(data.interactions.initialState);
const renderInteractionState=()=>{for(const node of scene.querySelectorAll("[data-element-id]")){const id=node.getAttribute("data-element-id"),offset=state.offsets[id],base=node.dataset.baseTransform??"";node.setAttribute("aria-pressed",String(id===state.selectedElementId));node.setAttribute("data-selected",String(id===state.selectedElementId));node.setAttribute("transform",(base+" translate("+(offset?.x??0)+" "+(offset?.y??0)+")").trim())}};
const dispatch=(event)=>{const binding=data.interactions.bindings.find((candidate)=>candidate.target===event.target&&candidate.event.kind===event.kind&&(candidate.event.kind!=="keyboard"||candidate.event.key===event.key));if(!binding)return;if(binding.action.kind==="select")state={...state,selectedElementId:binding.target};else if(binding.action.kind==="move"){const current=state.offsets[binding.target]??{x:0,y:0},multiplier=event.shiftKey?10:1;state={selectedElementId:binding.target,offsets:{...state.offsets,[binding.target]:{x:current.x+binding.action.x*multiplier,y:current.y+binding.action.y*multiplier}}}}renderInteractionState()};
const wrapTarget=(node)=>{const target=node.getAttribute("data-element-id"),box=node.getBBox(),wrapper=document.createElementNS(node.namespaceURI,"g"),hit=document.createElementNS(node.namespaceURI,"rect"),width=Math.max(44,box.width),height=Math.max(44,box.height);wrapper.setAttribute("data-element-id",target);wrapper.setAttribute("transform",node.getAttribute("transform")??"");hit.setAttribute("x",String(box.x-(width-box.width)/2));hit.setAttribute("y",String(box.y-(height-box.height)/2));hit.setAttribute("width",String(width));hit.setAttribute("height",String(height));hit.setAttribute("fill","transparent");hit.setAttribute("pointer-events","all");hit.setAttribute("aria-hidden","true");node.removeAttribute("data-element-id");node.removeAttribute("transform");node.parentNode.insertBefore(wrapper,node);wrapper.append(hit,node);return wrapper};
const bindInteractions=()=>{for(const original of [...scene.querySelectorAll("[data-element-id]")]){const node=wrapTarget(original),target=node.getAttribute("data-element-id");if(!target)continue;node.dataset.baseTransform=node.getAttribute("transform")??"";node.setAttribute("tabindex","0");node.setAttribute("role","button");node.addEventListener("pointerdown",()=>dispatch({kind:"pointer",target}));node.addEventListener("focus",()=>dispatch({kind:"focus",target}));node.addEventListener("keydown",(event)=>{if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))return;event.preventDefault();event.stopPropagation();dispatch({kind:"keyboard",target,key:event.key,shiftKey:event.shiftKey})})}renderInteractionState()};
const draw=()=>{scene.innerHTML=data.frames[frame].markup;scrub.value=String(frame);number.value=String(data.frames[frame].frame);bindInteractions()};
const stop=()=>{playing=false;play.textContent="Play"};
const seek=(next)=>{stop();frame=Math.max(0,Math.min(data.frames.length-1,next));draw()};
const tick=(now)=>{if(!playing)return;if(now-last>=1000/data.fps){frame=(frame+1)%data.frames.length;last=now;draw()}requestAnimationFrame(tick)};
const toggle=()=>{if(reduced.matches&&!playing)return;playing=!playing;play.textContent=playing?"Pause":"Play";if(playing)requestAnimationFrame(tick)};
play.addEventListener("click",toggle);scrub.addEventListener("input",()=>seek(Number(scrub.value)));
document.addEventListener("keydown",(event)=>{if(event.key === "ArrowRight")seek(frame+1);else if(event.key === "ArrowLeft")seek(frame-1);else if(event.key === "Home")seek(0);else if(event.key === "End")seek(data.frames.length-1);else if(event.key === " "){event.preventDefault();toggle()}});
reduced.addEventListener("change",()=>{if(reduced.matches)stop()});draw();
`;

async function listPackageFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("PACKAGE_INTEGRITY_FAILED");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile())
        files.push(relative(directory, absolute).split(sep).join(posix.sep));
      else throw new Error("PACKAGE_INTEGRITY_FAILED");
    }
  };
  await visit(directory);
  return files.sort();
}

export async function verifyNativeScenePackage(
  directory: string,
): Promise<void> {
  try {
    const parsed = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as Partial<ManifestV2>;
    if (
      parsed.schema !== "rvs.native-scene-package.v2" ||
      !/^[a-f0-9]{64}$/u.test(parsed.sceneDigest ?? "") ||
      !/^[a-f0-9]{64}$/u.test(parsed.runtimeFingerprint ?? "") ||
      parsed.registeredRuntimeDigest !== REGISTERED_RUNTIME_DIGEST ||
      !Array.isArray(parsed.files)
    )
      throw new Error("invalid manifest");
    if (
      parsed.creationPolicy?.assets !== "sha256-named" ||
      parsed.creationPolicy.externalUrls !== "forbidden" ||
      parsed.creationPolicy.generatedAt !== "omitted-for-reproducibility" ||
      parsed.files.some(
        (file) =>
          typeof file.path !== "string" ||
          typeof file.sha256 !== "string" ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes < 0,
      )
    )
      throw new Error("invalid manifest fields");
    const actual = (await listPackageFiles(directory)).filter(
      (path) => path !== "manifest.json",
    );
    const expected = parsed.files.map((file) => file.path);
    if (
      new Set(expected).size !== expected.length ||
      expected.some((path) => !SAFE_PATH.test(path)) ||
      JSON.stringify(actual) !== JSON.stringify([...expected].sort())
    )
      throw new Error("file set mismatch");
    for (const file of parsed.files) {
      const bytes = await readFile(join(directory, file.path));
      if (
        bytes.byteLength !== file.bytes ||
        digest(bytes) !== file.sha256 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256)
      )
        throw new Error("digest mismatch");
    }
    if (
      digest(await readFile(join(directory, "scene.json"))) !==
      parsed.sceneDigest
    )
      throw new Error("scene mismatch");
    if (digest(Buffer.from(RUNTIME_SCRIPT)) !== parsed.runtimeFingerprint)
      throw new Error("runtime mismatch");
  } catch (error) {
    if (error instanceof Error && error.message === "PACKAGE_INTEGRITY_FAILED")
      throw error;
    throw new Error("PACKAGE_INTEGRITY_FAILED", { cause: error });
  }
}

export async function buildNativeScenePackage(
  input: NativeScenePackageInput,
): Promise<NativeScenePackageResult> {
  const assetsDirectory = join(input.directory, "assets");
  const reportsDirectory = join(input.directory, "reports");
  await mkdir(assetsDirectory, { recursive: true });
  await mkdir(reportsDirectory, { recursive: true });
  const replacements = new Map<string, string>();
  const copiedAssets: Record<string, string> = {};
  for (const [assetId, sourcePath] of [...input.assetPaths].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    await assertRegularFile(sourcePath);
    const bytes = await readFile(sourcePath);
    const name = `${digest(bytes)}${safeExtension(sourcePath)}`;
    await cp(sourcePath, join(assetsDirectory, name));
    replacements.set(pathToFileURL(sourcePath).href, `assets/${name}`);
    copiedAssets[assetId] = `assets/${name}`;
  }
  await assertRegularFile(input.fontPath);
  const fontBytes = await readFile(input.fontPath);
  const fontName = `${digest(fontBytes)}${safeExtension(input.fontPath)}`;
  await cp(input.fontPath, join(assetsDirectory, fontName));
  const packagedAssets = new Set([
    ...Object.values(copiedAssets),
    `assets/${fontName}`,
  ]);

  const frames = input.frames.map((rendered) => {
    let markup = rendered.markup;
    for (const [source, target] of replacements)
      markup = markup.replaceAll(source, target);
    assertSafeMarkup(markup, packagedAssets);
    return { frame: rendered.frame, markup };
  });
  if (frames.length === 0) throw new Error("SCENE_PACKAGE_EMPTY");
  const sceneBytes = jsonBytes(input.scene);
  const runtimeData = JSON.stringify({
    fps: input.scene.canvas.fps,
    frames,
    interactions: createNativeInteractionModel(input.scene),
  }).replaceAll("</script", "<\\/script");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>@font-face{font-family:RvsLocal;src:url("assets/${fontName}")}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${input.scene.palette.background}}body{font-family:RvsLocal,sans-serif}#scene{width:100%;height:calc(100% - 48px)}svg{width:100%;height:100%}#scene [data-element-id]{cursor:pointer}#scene [data-element-id]:focus-visible{outline:3px solid #ffb347;outline-offset:3px}#controls{height:48px;display:flex;gap:12px;align-items:center;padding:0 12px;background:#18181c;color:#fff}button,input{min-width:44px;min-height:44px}input{flex:1}@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto!important}}</style></head>
<body><div id="scene"></div><div id="controls"><button id="play-pause" type="button">Play</button><label for="frame-scrub">Frame</label><input id="frame-scrub" type="range" min="0" max="${frames.length - 1}" value="0"><output id="frame-number">0</output></div><script id="scene-data" type="application/json">${runtimeData}</script><script>${RUNTIME_SCRIPT}</script></body></html>`;

  const capabilityBytes = jsonBytes(input.capability);
  const verificationBytes = jsonBytes(input.verification);
  const files = new Map<string, Uint8Array>([
    ["scene.json", sceneBytes],
    ["assets.json", jsonBytes(copiedAssets)],
    ["reports/capability.json", capabilityBytes],
    ["reports/verification.json", verificationBytes],
    ["capability.json", capabilityBytes],
    ["verification.json", verificationBytes],
    ["index.html", Buffer.from(html)],
  ]);
  for (const [path, bytes] of files)
    await writeFile(join(input.directory, path), bytes);
  for (const name of await readdir(assetsDirectory))
    files.set(`assets/${name}`, await readFile(join(assetsDirectory, name)));
  const manifestFiles = [...files]
    .map(
      ([path, bytes]): ManifestFile => ({
        path,
        sha256: digest(bytes),
        bytes: bytes.byteLength,
      }),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: ManifestV2 = {
    schema: "rvs.native-scene-package.v2",
    sceneDigest: digest(sceneBytes),
    runtimeFingerprint: digest(Buffer.from(RUNTIME_SCRIPT)),
    registeredRuntimeDigest: REGISTERED_RUNTIME_DIGEST,
    creationPolicy: {
      assets: "sha256-named",
      externalUrls: "forbidden",
      generatedAt: "omitted-for-reproducibility",
    },
    files: manifestFiles,
  };
  const manifestPath = join(input.directory, "manifest.json");
  await writeFile(manifestPath, jsonBytes(manifest));
  await verifyNativeScenePackage(input.directory);
  return { directory: input.directory, manifestPath };
}
