import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const fail = (message) => {
  throw new Error(`Package verification failed: ${message}`);
};

if (manifest.name !== "@haneoka/vega-renderer-three") fail("unexpected name");
if (manifest.license !== "MPL-2.0") fail("license must be MPL-2.0");
if (manifest.private === true) fail("package cannot be private");
if (manifest.sideEffects !== false) fail("sideEffects must be false");
if (manifest.publishConfig?.access !== "public") {
  fail("publishConfig.access must be public");
}
if (manifest.publishConfig?.provenance !== true) {
  fail("publishConfig.provenance must be enabled");
}
if (
  manifest.repository?.url !==
  "git+https://github.com/haneoka-gakuen/vega-renderer-three.git"
) {
  fail("repository URL is not canonical");
}
if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  fail("runtime dependencies must be peer dependencies");
}
if (Object.keys(manifest.optionalDependencies ?? {}).length > 0) {
  fail("optional runtime dependencies are not allowed");
}

const requiredPublishedDocuments = [
  "LICENSE",
  "LICENSE-SCOPE.md",
  "NOTICE.md",
  "THIRD_PARTY_NOTICES.md",
];
for (const document of requiredPublishedDocuments) {
  if (!(manifest.files ?? []).includes(document)) {
    fail(`${document} must be included in the published package`);
  }
  try {
    await access(resolve(root, document));
  } catch {
    fail(`missing required legal or provenance document ${document}`);
  }
}

const actualPeers = Object.keys(manifest.peerDependencies ?? {}).sort();
const expectedPeers = ["@haneoka/vega", "howler", "three"].sort();
if (JSON.stringify(actualPeers) !== JSON.stringify(expectedPeers)) {
  fail(`peer dependencies must be exactly ${expectedPeers.join(", ")}`);
}

const dependencyNames = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
];
const forbiddenDependency = /(?:live2d|cubism|motionsync|@esotericsoftware|spine)/iu;
for (const name of dependencyNames) {
  if (forbiddenDependency.test(name)) {
    fail(`forbidden character runtime dependency ${name}`);
  }
}

const collectTargets = (value) => {
  if (typeof value === "string") {
    return value.startsWith("./dist/") ? [value] : [];
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectTargets);
};
const targets = new Set(
  [
    manifest.main,
    manifest.module,
    manifest.types,
    ...collectTargets(manifest.exports),
  ].filter(
    (value) => typeof value === "string" && value.startsWith("./dist/"),
  ),
);
if (targets.size === 0) fail("manifest has no dist export targets");
for (const target of targets) {
  try {
    await access(resolve(root, target));
  } catch {
    fail(`manifest references missing build output ${target}`);
  }
}

const ignoredRoots = new Set([".dependencies", ".git", "coverage", "dist", "node_modules"]);
const forbiddenPath =
  /(?:^|\/)(?:assets?|character-models?|game-assets?|models?|sdk|vendor|runtime|core)(?:\/|$)|\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp3|ogg|wav|m4a|mp4|webm|moc|moc3|model3\.json|motion3\.json|physics3\.json|cdi3\.json|exp3\.json|skel|atlas|wasm|dll|dylib|so|node)$/iu;
const repositoryFiles = [];
const insideRoot = (path) => {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(sep))
  );
};
const walkRepository = async (path, relativePath = "") => {
  if (!insideRoot(path)) fail(`path escapes repository: ${path}`);
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail(`symbolic links are forbidden: ${relativePath}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (!relativePath && ignoredRoots.has(entry)) continue;
      await walkRepository(
        resolve(path, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
      );
    }
    return;
  }
  repositoryFiles.push(relativePath);
};
await walkRepository(root);
const forbiddenFiles = repositoryFiles.filter((path) => forbiddenPath.test(path));
if (forbiddenFiles.length > 0) {
  fail(`forbidden runtime or asset payload:\n${forbiddenFiles.join("\n")}`);
}
const removedPortSources = new Set([
  "src/rendering/post/UnityColorGrading.ts",
  "src/rendering/post/UnityColorUtils.ts",
]);
const restoredPortSources = repositoryFiles.filter((path) =>
  removedPortSources.has(path),
);
if (restoredPortSources.length > 0) {
  fail(`removed engine-port source restored:\n${restoredPortSources.join("\n")}`);
}
const requiredRendererSources = [
  "src/rendering/PostTextureResolver.ts",
  "src/rendering/three/AdvFieldTargetFormat.ts",
  "src/rendering/three/AdvLookTarget.ts",
  "src/rendering/three/AdvRainFrameRenderer.ts",
  "src/rendering/three/AdvVideoWait.ts",
  "src/rendering/three/PendingCharacterCommands.ts",
  "src/rendering/three/SharedTextureResourceCache.ts",
  "src/rendering/three/StoryDomOverlay.ts",
  "src/rendering/three/UnityAdvViewport.ts",
  "src/rendering/three/UnityTargetFrameClock.ts",
  "src/rendering/three/UnityTransform.ts",
  "src/rendering/three/transitions/AdvRuleTransition.ts",
  "src/rendering/three/transitions/AdvRuleTransitionPass.ts",
  "src/rendering/post/AdvFilmGrainAssets.ts",
];
for (const path of requiredRendererSources) {
  if (!repositoryFiles.includes(path)) {
    fail(`renderer-owned implementation is missing: ${path}`);
  }
}

let publishableBytes = 0;
const publishableFiles = [];
const walkPublishable = async (path, relativePath) => {
  if (!insideRoot(path)) fail(`publish path escapes repository: ${relativePath}`);
  if (!insideRoot(await realpath(path))) {
    fail(`publish path resolves outside repository: ${relativePath}`);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail(`publish path is a symlink: ${relativePath}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await walkPublishable(
        resolve(path, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
      );
    }
    return;
  }
  publishableFiles.push(relativePath);
  publishableBytes += (await stat(path)).size;
  const bytes = await readFile(path);
  if (bytes.includes(0)) fail(`binary payload found in ${relativePath}`);
};
for (const entry of manifest.files ?? []) {
  if (typeof entry !== "string" || !entry || entry.startsWith("/")) {
    fail(`invalid package files entry ${String(entry)}`);
  }
  await walkPublishable(resolve(root, entry), entry);
}
const forbiddenPublishable = publishableFiles.filter((path) =>
  forbiddenPath.test(path),
);
if (forbiddenPublishable.length > 0) {
  fail(`forbidden publish payload:\n${forbiddenPublishable.join("\n")}`);
}
const legacyPortOutput =
  /(?:^|\/)UnityColor(?:Grading|Utils)(?:\.|\/)/u;
const publishedLegacyPortOutput = publishableFiles.filter((path) =>
  legacyPortOutput.test(path),
);
if (publishedLegacyPortOutput.length > 0) {
  fail(
    `removed engine-port build output is publishable:\n${publishedLegacyPortOutput.join("\n")}`,
  );
}
if (publishableBytes > 5 * 1024 * 1024) {
  fail(`publish payload is unexpectedly large (${publishableBytes} bytes)`);
}

const builtJavaScript = await readFile(resolve(root, "dist/index.js"), "utf8");
const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu;
const externalImports = new Set(
  [...builtJavaScript.matchAll(importPattern)]
    .map((match) => match[1])
    .filter((specifier) => specifier && !specifier.startsWith(".")),
);
const allowedImports = new Set([
  "@haneoka/vega",
  "@haneoka/vega/renderer-kit",
  "three",
]);
const unexpectedImports = [...externalImports].filter(
  (specifier) => !allowedImports.has(specifier),
);
if (unexpectedImports.length > 0) {
  fail(`unexpected runtime imports: ${unexpectedImports.join(", ")}`);
}

const sourceEntries = await Promise.all(
  repositoryFiles
    .filter((path) => path.endsWith(".ts"))
    .map(async (path) => ({
      path,
      text: await readFile(resolve(root, path), "utf8"),
    })),
);
const sourceText = sourceEntries.map(({ text }) => text).join("\n");
const rendererKitImportPattern =
  /import\s*(?:type\s*)?\{([\s\S]*?)\}\s*from\s*["']@haneoka\/vega\/renderer-kit["']/gu;
const forbiddenCoreAdapterNames = [
  "AdvFieldTargetFormat",
  "AdvRainFrameRenderer",
  "AdvRuleTransitionController",
  "PendingCharacterCommands",
  "SharedTextureResourceCache",
  "StoryDomOverlay",
  "UnityTargetFrameClock",
  "computeAdvCharacterHeadWorldPosition",
  "computeAdvLookTarget",
  "createUnityAdvViewport",
  "detectAdvFieldTargetFormat",
  "threeVector3ToUnity",
  "unityEulerDegrees",
  "unityVector3",
];
for (const { path, text } of sourceEntries) {
  for (const match of text.matchAll(rendererKitImportPattern)) {
    const imports = match[1] ?? "";
    for (const name of forbiddenCoreAdapterNames) {
      if (new RegExp(`\\b${name}\\b`, "u").test(imports)) {
        fail(
          `renderer adapter ${name} must be imported locally, not from Vega core (${path})`,
        );
      }
    }
  }
}
const uberPostSource = await readFile(
  resolve(root, "src/rendering/post/AdvUrpUberPost.ts"),
  "utf8",
);
const publicEntrySource = await readFile(
  resolve(root, "src/index.ts"),
  "utf8",
);
if (
  !uberPostSource.includes("resolveAdvFilmGrainTextureBinding") ||
  !sourceText.includes('haneoka.renderer-three/film-grain')
) {
  fail("film-grain built-ins must resolve through stable host asset requests");
}
if (
  !publicEntrySource.includes("context.provide") ||
  !publicEntrySource.includes("THREE_POST_TEXTURE_RESOLVER") ||
  !publicEntrySource.includes("createThreePostTextureUrlResolver")
) {
  fail("the renderer plugin must register its post-texture resolver service");
}
for (const forbidden of [
  /vendor\/cubism/iu,
  /ensureCubism(?:2)?Framework/iu,
  /createDefaultModel/iu,
  /CubismCore/iu,
  /AdvHdrLutShaders/iu,
  /LutBuilderHdr/iu,
  /globalgamemanagers\.assets/iu,
  /PathID\s+113/iu,
  /extracted\s+(?:compiled\s+)?shader/iu,
  /assets\/urp\/film-grain/iu,
  /UnityEngine\.Rendering\.ColorUtils/iu,
  /\bColorBalanceToLMSCoeffs\b/u,
  /\bPrepareLiftGammaGain\b/u,
  /\bPrepareShadowsMidtonesHighlights\b/u,
  /\b(?:ported|adapted|copied|translated)\b[^\n]{0,120}\bUnity\b/iu,
  /\bUnity\b[^\n]{0,120}\b(?:ported|adapted|copied|translated)\b/iu,
  /\b0\.27509507\b/u,
  /\b0\.949237\b/u,
  /\btemperature\s*\/\s*65\b/iu,
]) {
  if (forbidden.test(sourceText)) {
    fail(`source contains forbidden runtime or provenance reference ${forbidden}`);
  }
}

console.log(
  `Verified ${manifest.name}: ${targets.size} exports, ${publishableFiles.length} files, ${publishableBytes} bytes.`,
);
