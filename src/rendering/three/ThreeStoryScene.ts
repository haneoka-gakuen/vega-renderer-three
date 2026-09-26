import { ScreenSpriteRenderer } from "./ScreenSpriteRenderer";
import {
  AdaptiveRenderQuality,
  DEFAULT_SCENE_GEOMETRY,
  STORY_SCREEN_FILTER_PROVIDER,
  StoryScreenEffects,
  STORY_FRAME_LAYOUT_PROVIDER,
  STORY_STILL_PRESENTATION_PROVIDER,
  resolveStoryPlaneLayout,
  scenePlaneSize,
  scenePointFromPixels,
  type SceneCoordinateReference,
  type StoryPlaneLayout,
  isStoryScreenSpriteEffect,
  type StoryScreenEffectDefinition,
  AdvCamera,
  AdvQualityConfig,
  createAdvDotweenShakePath,
  createRendererCharacterModel,
  disposeRendererCharacterModel,
  isRendererAwareCharacterProvider,
  sampleAdvDotweenShake,
  registerCharacterItem,
  iterateAdvCommands,
  normalizeStoryResourceDeclarations,
  UNITY_CHARACTER_FADE_DELAY_FRAMES,
  UnityCharacterFadeCoordinator,
  advCharacterExpressions,
  advCharacterMotions,
  clampCameraDistance,
  FOCUS_DATA_BY_KEY,
  lerp,
  mergeAdvRuntime,
  resolveEase,
  tween,
  type AdvBackgroundEntry,
  type AdvCommand,
  type AdvEffectEntry,
  type AdvFocusDataRow,
  type AdvFrameEntry,
  type AdvPlayerState,
  type AdvPostEffectEntry,
  type AdvRuleTransitionEntry,
  type AdvRuntimeConfig,
  type AdvStillEntry,
  type AdvStory,
  type AdvStorySceneSeekSnapshot as PortableAdvStorySceneSeekSnapshot,
  type AdvVideoEntry,
  type StoryCharacterProvider,
  type RendererAwareStoryCharacterProvider,
  type StoryResourceResolver,
  type StoryCharacterPreloadRequest,
  type StoryCharacterRendererModelContext,
  type StoryRendererEffectContribution,
  type StoryRendererExtensionContext,
  type StoryRendererResourcePreparationContext,
  type StoryResourceDeclaration,
  type StoryScreenFilterController,
  type StoryScreenFilterProvider,
  type VegaDisposable,
  type StorySceneBackend,
  type StorySceneBackendContext,
  type StoryScenePreviewOptions,
  type VegaVoiceAnalysisSource,
} from "@haneoka/vega/renderer-kit";
import {
  Color,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  NoColorSpace,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import {
  isThreeStoryCharacterModel,
  type ThreeCharacterParameterBlend,
  type ThreeCharacterParameterFrame,
  type ThreeRendererMultiplyTextureOptions,
  type ThreeStoryCharacterModel,
} from "../ThreeCharacterModel";
import { StaticPortraitModel } from "../portrait/StaticPortraitModel";
import { loadRendererImage } from "../ImageResource";
import { THREE_POST_TEXTURE_RESOLVER, storyPostTextureRequests } from "../PostTextureResolver";
import { evaluateAdvHarmonicMotion, type AdvHarmonicMotionData } from "../CharacterHarmonicMotion";
import {
  DEFAULT_UNITY_CHARACTER_LIGHTING,
  UNITY_CHARACTER_REFERENCE_FLAT_WHITE_SH,
  packUnityUrpAdditionalLights,
  packUnityUrpDirectionalLight,
  type UnityCharacterAdditionalLightLike,
  type UnityCharacterLightingState,
} from "../UnityCharacterLighting";
import { AdvPostPipeline, type AdvSceneLayer } from "./AdvPostPipeline";
import type { AdvColorGradingPipelineMode } from "../post/AdvUrpPostProcessor";
import { advVolumeProfileKey, type AdvVolumeLayer, type UnityVolumeProfile } from "../post/AdvVolumeStack";
import { StoryCharacter } from "./StoryCharacter";
import { sceneTransformMatrix } from "./SceneTransform";
import { ScreenFilterRunner, type ScreenFilterBounds } from "./ScreenFilterRunner";
import { UnityParticleEffectController } from "../particles/UnityParticleEffect";
import type { UnityEffectRuntimeDefinition } from "../particles/UnityParticleTypes";
import { resolveAdvEffectRoute, type AdvEffectRoute } from "../particles/AdvEffectRoute";
import { AdvRuleTransitionController } from "./transitions/AdvRuleTransition";
import { AdvRuleTransitionPass } from "./transitions/AdvRuleTransitionPass";
import { sampleVoiceMotionSyncInput, voiceRmsMouthOpening } from "./VoiceMotionSync";
import { SharedTextureResourceCache, type SharedTextureLease } from "./SharedTextureResourceCache";
import { StoryDomOverlay } from "./StoryDomOverlay";
import { UnityTargetFrameClock } from "./UnityTargetFrameClock";
import { computeAdvCharacterHeadWorldPosition, computeAdvLookTarget } from "./AdvLookTarget";
import { createUnityAdvViewport, unityAdvOrientedTargetAspect } from "./UnityAdvViewport";
import { detectAdvFieldTargetFormat } from "./AdvFieldTargetFormat";
import { threeVector3ToUnity, unityEulerDegrees, unityVector3 } from "./UnityTransform";
import {
  PendingCharacterCommands,
  type PendingCharacterAlphaEvent,
  type PendingCharacterAngleEvent,
  type PendingCharacterBrightness,
  type PendingCharacterDoF,
  type PendingCharacterDoFSet,
  type PendingCharacterLipSync,
  type PendingCharacterLookEvent,
  type PendingCharacterPauseEvent,
  type PendingCharacterPresentation,
  type PendingCharacterRimLightEvent,
} from "./PendingCharacterCommands";
import { advanceAdvHoldOpenPseudoLipSync, advanceAdvPseudoLipSync } from "../CharacterLipSyncMath";
import type {
  FieldRendererState,
  StoryCharacterEntry,
  StoryCameraState,
  Vec2,
  Vec3,
  VoiceAnalysisSource,
} from "./StorySceneTypes";
import {
  STORY_SCENE_SEEK_SNAPSHOT_VERSION,
  isDetailedThreeStorySceneSeekSnapshot,
  type AdvCharacterPresentationEvent,
  type AdvStorySceneSeekSnapshot,
  type SeekSnapshotSafety,
} from "./StorySceneSnapshot";

type BackgroundMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;
type UnknownRecord = Record<string, unknown>;

interface CommandVolumeState {
  profile: UnityVolumeProfile;
  weight: number;
  enabled: boolean;
  version: number;
}

interface CommandEffectState {
  readonly key: string;
  readonly effect: AdvEffectEntry;
  readonly atOnce: boolean;
  readonly simulationSpeed: number;
  readonly positionType?: number;
  readonly targetName: string;
  readonly canvasLayers: readonly unknown[];
}

interface RendererExtensionEffectInstance {
  readonly key: string;
  readonly contribution: StoryRendererEffectContribution;
  readonly controller: AbortController;
  readonly detach: () => void;
  resource: VegaDisposable | null;
  stopRequested: boolean;
  resourceDisposed: boolean;
}

interface PendingStageCapture {
  readonly generation: number;
  readonly resolve: (generation: number | null) => void;
}

interface PendingCharacterPlacement {
  readonly token: number;
  readonly entry: StoryCharacterEntry;
  readonly positionType: number;
  readonly identity: string;
  readonly worldPosition: Vec3 | null;
  readonly fadeInDurationSeconds: number;
  fadeInStartedAtSeconds: number | null;
}

interface PendingCharacterWorldPosition {
  readonly token: number;
  readonly positionType: number;
  readonly position: Vec3;
}

interface StagedCharacterItem {
  readonly token: number;
  readonly item: StoryCharacter;
}

interface PendingCharacterLoadController {
  readonly token: number;
  readonly controller: AbortController;
  readonly detach: () => void;
}

interface CharacterPreloadState {
  readonly controller: AbortController;
  readonly detach: () => void;
  readonly promise: Promise<StoryCharacter | null>;
  readonly commandIndex: number;
}

interface CharacterRenderPrimeState {
  readonly item: StoryCharacter;
  readonly contextGeneration: number;
  readonly detach: () => void;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  fence: WebGLSync | null;
}

interface CharacterGraphicsRestoreFailure {
  readonly item: StoryCharacter;
  readonly error: unknown;
}

interface CharacterModelRecoveryState {
  generation: number;
  attempts: number;
  retryAtSeconds: number;
  controller: AbortController | null;
  detach: (() => void) | null;
}

interface ContextRestoreController {
  readonly controller: AbortController;
  readonly detach: () => void;
}

interface SceneUpdateFailureState {
  failures: number;
  retryAtSeconds: number;
}

async function loadPngTexture(url: string, resources?: StoryResourceResolver, signal?: AbortSignal): Promise<Texture> {
  const image = await loadRendererImage(url, resources, signal);
  const texture = new Texture(image);
  // PlayerSettings.m_ActiveColorSpace=Gamma. Unity therefore samples
  // imported ADV textures without hardware sRGB decoding.
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const defaultSharedTextureCache = new SharedTextureResourceCache<string, Texture>(
  (url, signal) => loadPngTexture(url, undefined, signal),
  (texture) => texture.dispose(),
  48,
);
const resolverTextureCaches = new WeakMap<StoryResourceResolver, SharedTextureResourceCache<string, Texture>>();

const textureCacheFor = (resources?: StoryResourceResolver): SharedTextureResourceCache<string, Texture> => {
  if (!resources) return defaultSharedTextureCache;
  let cache = resolverTextureCaches.get(resources);
  if (!cache) {
    cache = new SharedTextureResourceCache<string, Texture>(
      (url, signal) => loadPngTexture(url, resources, signal),
      (texture) => texture.dispose(),
      48,
    );
    resolverTextureCaches.set(resources, cache);
  }
  return cache;
};
const DEG_TO_RAD = Math.PI / 180;
const PSEUDO_LIP_UNIT_TIME = 0.14;
const PSEUDO_LIP_STOP_DURATION = 0.3;
const FLOAT_EPSILON = 1e-45;
const ADV_UI_REFERENCE_HEIGHT = 1080;
const CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD = 4;
const CHARACTER_MODEL_RECOVERY_MAX_DELAY_SECONDS = 30;
const CHARACTER_MODEL_RECOVERY_PREPARE_MAX_PASSES = 3;
const ZERO_VEC3: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
const BACKGROUND_FIELD_POSITION: Readonly<Vec3> = DEFAULT_SCENE_GEOMETRY.backgroundFieldPosition;
const CHARACTER_FIELD_POSITION: Readonly<Vec3> = DEFAULT_SCENE_GEOMETRY.characterFieldPosition;
const CHARACTER_BASE_POSITION: Readonly<Vec3> = { x: 0, y: -0.41, z: 0 };
const WHITE_CHARACTER_COLOR = [1, 1, 1, 1] as const;

interface MutableColor4 {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface CharacterRenderGroup {
  readonly settings: {
    blur: number;
    alpha: number;
    brightness: number;
    radiusMax: number;
    filterTarget?: string;
    filter?: (target: WebGLRenderTarget) => void;
  };
  readonly items: StoryCharacter[];
}

export interface ThreeStorySceneOptions {
  /** Stable provider route. */
  readonly rendererId?: typeof VEGA_THREE_RENDERER_ID | typeof LEGACY_HANEOKA_THREE_RENDERER_ID;
  readonly profile?: "vega" | "unity-adv";
  readonly staticPortraitFallback?: boolean;
  /** LDR is the default; HDR bakes tone mapping into a logarithmic scene LUT. */
  readonly colorGradingMode?: AdvColorGradingPipelineMode;
}

export const VEGA_THREE_RENDERER_ID = "vega-three-webgl2" as const;
export const LEGACY_HANEOKA_THREE_RENDERER_ID = "haneoka-three-webgl2" as const;

export interface ThreeRendererEffectTarget {
  readonly key: string;
  readonly route: AdvEffectRoute;
  readonly scene: Scene;
  readonly anchor: Object3D | null;
  readonly atOnce: boolean;
  readonly simulationSpeed: number;
}

export interface ThreeRendererContext {
  readonly gl: WebGL2RenderingContext;
  readonly threeRenderer: WebGLRenderer;
  readonly rendererId: typeof VEGA_THREE_RENDERER_ID | typeof LEGACY_HANEOKA_THREE_RENDERER_ID;
  readonly rendererAliases: readonly [typeof LEGACY_HANEOKA_THREE_RENDERER_ID];
  readonly profile: "vega" | "unity-adv";
  readonly runtime: AdvRuntimeConfig;
  readonly state: AdvPlayerState;
  /** Stable Three roots available to renderer-aware character and effect plugins. */
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly backgroundField: Object3D;
  readonly characterField: Object3D;
  readonly foregroundField: Object3D;
  /** Present only while constructing a command-effect contribution. */
  readonly effectTarget?: ThreeRendererEffectTarget;
}

type ThreeRendererId = typeof VEGA_THREE_RENDERER_ID | typeof LEGACY_HANEOKA_THREE_RENDERER_ID;

type ThreeCharacterProvider = StoryCharacterProvider<ThreeRendererId, ThreeRendererContext, ThreeStoryCharacterModel>;

type ThreeRendererAwareCharacterProvider = RendererAwareStoryCharacterProvider<
  ThreeRendererId,
  ThreeRendererContext,
  ThreeStoryCharacterModel
> & {
  readonly supportsRenderer?: (renderer: ThreeRendererId) => boolean;
};

type ThreeCharacterProviderContext = StoryCharacterRendererModelContext<ThreeRendererId, ThreeRendererContext>;

function finite(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function clamp(value: unknown, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, finite(value, minimum)));
}

function sceneAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function waitForScenePromise<Value>(
  pending: Promise<Value>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<Value> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(sceneAbortError(message));
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = (): void => finish(() => reject(sceneAbortError(message)));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function isVegaDisposable(value: unknown): value is VegaDisposable {
  if (typeof value === "function") return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    dispose?: unknown;
    destroy?: unknown;
    close?: unknown;
  };
  return (
    typeof candidate.dispose === "function" ||
    typeof candidate.destroy === "function" ||
    typeof candidate.close === "function"
  );
}

async function disposeVegaDisposable(resource: VegaDisposable): Promise<void> {
  if (typeof resource === "function") {
    await resource();
    return;
  }
  if ("dispose" in resource) {
    await resource.dispose();
    return;
  }
  if ("destroy" in resource) {
    await resource.destroy();
    return;
  }
  await resource.close();
}

/** Mathf.Approximately, as in AdvFieldRenderPass character grouping. */
function unityApproximately(left: number, right: number): boolean {
  return Math.abs(left - right) < Math.max(0.000001 * Math.max(Math.abs(left), Math.abs(right)), 8 * FLOAT_EPSILON);
}

function hashSeed(value: unknown): number {
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 0x9e3779b9;
}

function nextRandom(seed: { value: number }): number {
  seed.value = Math.imul(seed.value ^ (seed.value >>> 15), seed.value | 1) >>> 0;
  return seed.value / 4294967295;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function clonePlain<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function vec3(value: unknown, fallback: Readonly<Vec3>, target: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const source = record(value);
  target.x = finite(source.x, fallback.x);
  target.y = finite(source.y, fallback.y);
  target.z = finite(source.z, fallback.z);
  return target;
}

function worldPosition(value: unknown): Vec3 | null {
  const source = record(value);
  if (
    ![source.x, source.y, source.z].every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    return null;
  }
  return { x: source.x as number, y: source.y as number, z: source.z as number };
}

function positiveFinite(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function textureAspect(texture: Texture, fallback = 16 / 9): number {
  const source = record(texture.source);
  const image = record(texture.image || source.data);
  const width = positiveFinite(image.naturalWidth ?? image.videoWidth ?? image.width);
  const height = positiveFinite(image.naturalHeight ?? image.videoHeight ?? image.height);
  return width && height ? width / height : fallback;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" ? value : "";
    if (text) return text;
  }
  return "";
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function nextPreloadPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    if (globalThis.document?.visibilityState !== "hidden") {
      frame = requestAnimationFrame(finish);
    }
    timer = setTimeout(finish, 16);
  });
}

function colorComponents(value: unknown): { r: number; g: number; b: number; a: number } {
  if (typeof value === "number" && Number.isFinite(value)) {
    const packed = Math.trunc(value) >>> 0;
    return {
      r: ((packed >>> 16) & 0xff) / 255,
      g: ((packed >>> 8) & 0xff) / 255,
      b: (packed & 0xff) / 255,
      a: packed > 0xffffff ? ((packed >>> 24) & 0xff) / 255 : 1,
    };
  }
  if (typeof value === "string") {
    const color = new Color(value || "#ffffff");
    return { r: color.r, g: color.g, b: color.b, a: 1 };
  }
  const source = record(value);
  return {
    r: clamp(source.r, 0, 2),
    g: clamp(source.g, 0, 2),
    b: clamp(source.b, 0, 2),
    a: clamp(source.a, 0, 1),
  };
}

function unityHtmlColor(value: unknown): { r: number; g: number; b: number; a: number } {
  const source = String(value ?? "")
    .trim()
    .toLowerCase();
  const hex = source.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;
    const hasAlpha = expanded.length === 8;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16) / 255,
      g: Number.parseInt(expanded.slice(2, 4), 16) / 255,
      b: Number.parseInt(expanded.slice(4, 6), 16) / 255,
      a: hasAlpha ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const named = Color.NAMES[source as keyof typeof Color.NAMES];
  if (named != null) {
    return {
      r: ((named >>> 16) & 0xff) / 255,
      g: ((named >>> 8) & 0xff) / 255,
      b: (named & 0xff) / 255,
      a: 1,
    };
  }
  // AdvRimLightCommand initializes the out color to Color.white and ignores
  // TryParseHtmlString's false result.
  return { r: 1, g: 1, b: 1, a: 1 };
}

function stageSpriteTint(value: unknown, target: MutableColor4 = { r: 1, g: 1, b: 1, a: 1 }): MutableColor4 {
  const source = record(value);
  // AdvBackgroundField.SetStageInfo copies all four serialized floats directly
  // into SpriteRenderer.color; unlike public UI colors, this path performs no
  // clamp before ApplyBrightness multiplies RGB.
  target.r = finite(source.r, 1);
  target.g = finite(source.g, 1);
  target.b = finite(source.b, 1);
  target.a = finite(source.a, 1);
  return target;
}

/**
 * Three/WebGL2 implementation of the Vega ADV scene root.
 *
 * The class keeps the existing command-facing contract, but all field roots,
 * character stages and the camera are real 3D transforms. Character plugins
 * submit into the exact framebuffer owned by the Three post pipeline.
 */
export class ThreeStoryScene implements StorySceneBackend {
  readonly backend: string;
  readonly rendererId: typeof VEGA_THREE_RENDERER_ID | typeof LEGACY_HANEOKA_THREE_RENDERER_ID;
  readonly profile: "vega" | "unity-adv";
  runtime: AdvRuntimeConfig;
  state: AdvPlayerState;
  readonly scene = new Scene();
  readonly backgroundCaptureScene = new Scene();
  // SceneCamera.asset serializes near=.3 and far=5000; UniversalCamera only
  // replaces the authored ADV FOV/pose during setup.
  readonly camera = new PerspectiveCamera(39.6, 13 / 6, 0.3, 5000);
  readonly backgroundField = new Object3D();
  private readonly backgroundCaptureField = new Object3D();
  readonly characterField = new Object3D();
  readonly foregroundField = new Object3D();
  readonly screenTransformChannels: readonly string[];
  private readonly sceneTransforms = new Map<
    string,
    { current: Record<string, number>; planned: Record<string, number> }
  >();
  private readonly screenFilterProvider: StoryScreenFilterProvider | undefined;
  private screenFilterRunner: ScreenFilterRunner | undefined;
  private readonly screenFilters = new Map<
    string,
    {
      controller: StoryScreenFilterController;
      values: Readonly<Record<string, number>>;
      render: (target: WebGLRenderTarget) => void;
    }
  >();
  private readonly filterBoundsMatrix = new Matrix4();
  private readonly filterBoundsPoint = new Vector3();
  private readonly filterBackground = (target: WebGLRenderTarget) => this.renderScreenFilter("bg-main", target);
  private readonly filterStage = (target: WebGLRenderTarget) => this.renderScreenFilter("stage-main", target);
  private readonly sceneTargetMatrix = new Matrix4();
  private readonly sceneParentMatrix = new Matrix4();
  private readonly sceneParentInverse = new Matrix4();
  private readonly scenePivot = new Vector3();
  private readonly sceneReferenceRotation = new Quaternion();
  private readonly spritePlaneMatrix = new Matrix4();
  private readonly spriteProjection = new Matrix4();
  private readonly sceneReferenceCache = new WeakMap<object, SceneCoordinateReference>();
  private readonly placementCache = new WeakMap<
    StoryCharacter,
    { stage: object; positions: Map<number, { position: Vec3; origin: Vec3; scale: number }> }
  >();

  private coordinateReference(): SceneCoordinateReference {
    const stage = this.runtime.stage;
    let reference = this.sceneReferenceCache.get(stage);
    if (!reference) {
      const rotation = vec3(stage.initialCameraRotation, ZERO_VEC3);
      reference = {
        width: Math.max(1, finite(record(stage).screenReferenceWidth, 2560)),
        height: Math.max(1, finite(record(stage).screenReferenceHeight, 1440)),
        fov: finite(stage.fov, 39.6),
        position: vec3(stage.initialCameraPosition, ZERO_VEC3),
        rotation: { x: -rotation.x, y: rotation.y, z: rotation.z },
      };
      this.sceneReferenceCache.set(stage, reference);
    }
    return reference;
  }

  private coordinateDepth(target: string): number {
    const reference = this.coordinateReference();
    const field =
      target === "bg-main"
        ? (this.runtime.stage.backgroundFieldPosition ?? BACKGROUND_FIELD_POSITION)
        : (this.runtime.stage.characterFieldPosition ?? CHARACTER_FIELD_POSITION);
    return Math.max(0.001, field.z - reference.position.z);
  }

  readSceneTransform(target: string): { current: Record<string, number>; planned: Record<string, number> } | undefined {
    return this.sceneTransforms.get(target);
  }

  clearSceneTransform(target: string): void {
    this.sceneTransforms.delete(target);
    this.screenFilter(target);
  }

  clearScreenTransform(target: string): void {
    this.clearSceneTransform(target);
  }

  writeSceneTransform(
    target: string,
    value: { current: Readonly<Record<string, number>>; planned: Readonly<Record<string, number>> },
  ): void {
    this.sceneTransforms.set(target, { current: { ...value.current }, planned: { ...value.planned } });
    this.screenFilter(target);
  }

  readScreenTransform(
    target: string,
  ): { current: Record<string, number>; planned: Record<string, number> } | undefined {
    const value = this.readSceneTransform(target);
    if (!value) return undefined;
    const reference = this.coordinateReference(),
      unit = scenePlaneSize(reference, this.coordinateDepth(target)).height / reference.height;
    const convert = (v: Readonly<Record<string, number>>) => ({
      ...v,
      x: (v.x ?? 0) / unit,
      y: -(v.y ?? 0) / unit,
      rotation: -(v.rotation ?? 0),
    });
    return { current: convert(value.current), planned: convert(value.planned) };
  }

  writeScreenTransform(
    target: string,
    value: { current: Readonly<Record<string, number>>; planned: Readonly<Record<string, number>> },
  ): void {
    const reference = this.coordinateReference(),
      unit = scenePlaneSize(reference, this.coordinateDepth(target)).height / reference.height;
    const convert = (v: Readonly<Record<string, number>>) => ({
      ...v,
      x: (v.x ?? 0) * unit,
      y: -(v.y ?? 0) * unit,
      rotation: -(v.rotation ?? 0),
    });
    this.writeSceneTransform(target, { current: convert(value.current), planned: convert(value.planned) });
  }
  private screenFilter(target: string) {
    const values = this.readSceneTransform(target)?.current;
    const existing = this.screenFilters.get(target);
    if (!values || !this.screenFilterProvider) {
      if (existing) {
        existing.controller.dispose();
        this.screenFilters.delete(target);
      }
      return undefined;
    }
    if (existing?.values === values) return existing;
    const entry = existing ?? {
      controller: this.screenFilterProvider.create(target),
      values,
      render: (texture: WebGLRenderTarget) => this.renderScreenFilter(target, texture),
    };
    entry.controller.configure(values);
    entry.values = values;
    this.screenFilters.set(target, entry);
    return entry;
  }
  private renderScreenFilter(target: string, texture: WebGLRenderTarget): void {
    const filter = this.screenFilter(target)?.controller;
    if (!filter?.active || !this.renderer) return;
    this.screenFilterRunner ??= new ScreenFilterRunner(this.renderer);
    this.screenFilterRunner.render(
      filter,
      texture,
      this.renderer.getPixelRatio(),
      this.screenFilterBounds(target, texture.width, texture.height),
    );
  }
  private screenFilterBounds(target: string, width: number, height: number): ScreenFilterBounds | undefined {
    if (target === "stage-main") return undefined;
    const item = this.characterItems.get(target);
    let bounds: { x: number; y: number; width: number; height: number };
    if (item) {
      bounds = Boolean(record(item.entry.profile).placement)
        ? this.characterCanvasBounds(item)
        : (item.model.drawableBounds() ?? item.model.canvasBounds());
      this.characterProjection(item, this.filterBoundsMatrix);
    } else if (target === "bg-main" && this.backgroundMesh) {
      const mesh = this.backgroundMesh;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) return undefined;
      bounds = { x: box.min.x, y: box.min.y, width: box.max.x - box.min.x, height: box.max.y - box.min.y };
      this.filterBoundsMatrix
        .copy(this.camera.projectionMatrix)
        .multiply(this.camera.matrixWorldInverse)
        .multiply(mesh.matrixWorld);
    } else return undefined;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      const point = this.filterBoundsPoint
        .set(bounds.x + x * bounds.width, bounds.y + y * bounds.height, 0)
        .applyMatrix4(this.filterBoundsMatrix);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return undefined;
    return {
      x: ((minX + 1) * width) / 2,
      y: ((minY + 1) * height) / 2,
      width: ((maxX - minX) * width) / 2,
      height: ((maxY - minY) * height) / 2,
    };
  }
  readonly characterItems = new Map<string, StoryCharacter>();
  private readonly characterControllerIdentities = new Map<string, string>();
  private readonly cachedCharacterControllers = new Map<string, StoryCharacter>();
  private readonly characterPreloads = new Map<string, CharacterPreloadState>();
  /** Controllers made ready ahead of, but not yet consumed by, their first In. */
  private readonly speculativeCharacterControllers = new Map<string, StoryCharacter>();
  private readonly speculativeCharacterCommandIndices = new Map<string, number>();
  private readonly discardedCharacterPreloadIdentities = new Set<string>();
  private readonly characterPreloadCapacityWaiters = new Set<() => void>();
  private readonly characterRenderPrimes = new Map<StoryCharacter, CharacterRenderPrimeState>();
  private readonly sortedCharacterItems: StoryCharacter[] = [];
  private readonly characterRenderGroupPool: CharacterRenderGroup[] = [];
  private readonly stagedCharacterItems = new Map<string, StagedCharacterItem>();
  private readonly pendingCharacterPlacements = new Map<string, PendingCharacterPlacement>();
  private readonly pendingCharacterWorldPositions = new Map<string, PendingCharacterWorldPosition>();
  private readonly pendingAngleWaitControllers = new Map<string, AbortController>();
  private readonly pendingLookWaitControllers = new Map<string, AbortController>();
  private readonly pendingCharacterLoadControllers = new Map<string, PendingCharacterLoadController>();
  readonly cameraState: StoryCameraState = {
    rotationY: 0,
    fieldRotationY: 0,
    stageRotationY: 0,
    rotationX: 0,
    angle: 0,
    zoomRatio: 1,
    baseX: 0,
    baseY: 0,
    baseZ: 0,
    panOffsetX: 0,
    panOffsetY: 0,
    focusPositionType: 5,
    focusTargetName: "",
  };
  readonly fieldRendererState: FieldRendererState = {
    distance: 0,
    blurRadiusMax: 0.75,
    curvedLensRate: 1,
    backgroundBlur: 0,
    characterBlur: 0,
    brightness: 1,
  };

  private readonly screenEffects: StoryScreenEffects;
  private screenSprites: ScreenSpriteRenderer | undefined;
  private readonly renderScreenBackground = (target: WebGLRenderTarget) =>
    this.screenSprites?.render("background", target, this.spritePlaneProjection("background"));
  private readonly renderScreenForeground = (target: WebGLRenderTarget) =>
    this.screenSprites?.render("foreground", target, this.spritePlaneProjection("foreground"));
  get screenEffectKeys(): readonly string[] {
    return this.screenEffects.keys;
  }
  async setScreenEffect(key: string, definition: StoryScreenEffectDefinition, signal?: AbortSignal): Promise<void> {
    await this.screenEffects.set(key, definition, signal);
  }
  clearScreenEffects(key?: string): void {
    this.screenEffects.clear(key);
  }
  private syncScreenEffects(): void {
    if (!this.renderer) return;
    if (this.screenEffects.batches.length) this.screenSprites ??= new ScreenSpriteRenderer(this.renderer);
    this.screenSprites?.sync(this.screenEffects.batches);
  }
  private renderer: WebGLRenderer | null = null;
  private pipeline: AdvPostPipeline | null = null;
  private overlay: StoryDomOverlay | null = null;
  private ruleTransitionPass: AdvRuleTransitionPass | null = null;
  private mount: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrame = 0;
  private previousFrameTime = 0;
  private lastRenderedTimeSeconds = 0;
  private readonly targetFrameClock = new UnityTargetFrameClock();
  private backgroundMesh: BackgroundMesh | null = null;
  private backgroundCaptureMesh: BackgroundMesh | null = null;
  private backgroundTextureLease: SharedTextureLease<Texture> | null = null;
  private readonly backgroundGeometry = new PlaneGeometry(1, 1);
  private readonly backgroundBaseMaterial = new MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
    side: FrontSide,
    toneMapped: false,
  });
  private readonly backgroundCaptureBaseMaterial = this.backgroundBaseMaterial.clone();
  private readonly backgroundBaseMesh = new Mesh(this.backgroundGeometry, this.backgroundBaseMaterial);
  private readonly backgroundCaptureBaseMesh = new Mesh(this.backgroundGeometry, this.backgroundCaptureBaseMaterial);
  private readonly stageNodes = new Map<number, Object3D>();
  private readonly stageOffsets = new Map<number, Vec3>();
  private readonly characterFadeCoordinator = new UnityCharacterFadeCoordinator();
  private readonly commandEffects: UnityParticleEffectController;
  private readonly stageEffects: UnityParticleEffectController;
  private readonly commandEffectStates = new Map<string, CommandEffectState>();
  private readonly rendererExtensionEffects = new Map<string, RendererExtensionEffectInstance>();
  private readonly pendingRendererEffectOperations = new Set<Promise<void>>();
  private readonly commandAdvBackScene = new Scene();
  private readonly commandAdvFrontScene = new Scene();
  private readonly commandUiScene = new Scene();
  private readonly commandCharacterScenes = new Map<number, Scene>();
  private readonly stageParticleKeys = new Set<string>();
  private readonly ruleTransition = new AdvRuleTransitionController();
  private ruleTransitionTextureLease: SharedTextureLease<Texture> | null = null;
  private ruleTransitionVersion = 0;
  private readonly textureCacheKeys = new Set<string>();
  // AdvFieldRendererManager owns one cancellation source per renderer entry.
  // Focus and DoF therefore cancel/replace one another instead of combining.
  private backgroundBlurTweenVersion = 0;
  private readonly characterBlurTweenVersions = new Map<string, number>();
  private backgroundBlurTweenController: AbortController | null = null;
  private readonly characterBlurTweenControllers = new Map<string, AbortController>();
  private readonly characterBrightnessTweenControllers = new Map<string, AbortController>();
  private readonly renderMvp = new Matrix4();
  private readonly characterDrawState = {
    objectToWorld: this.renderMvp,
    timeSeconds: 0,
  };
  private readonly renderWorldPosition = new Vector3();
  private readonly renderUnityPosition = new Vector3();
  private readonly placementUnityPosition = new Vector3();
  private readonly scratchBackgroundPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchCharacterPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchStagePosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchCharacterBasePosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchEuler: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchTint: MutableColor4 = { r: 1, g: 1, b: 1, a: 1 };
  private readonly stageNodeKeys = new Set<number>([1, 3, 5, 7, 9]);
  private readonly sceneLayerCache = new Map<Scene, AdvSceneLayer>();
  private readonly postBeginOptions: {
    clearColor: number;
    clearAlpha: number;
    captureStage: boolean;
    stageCaptureScene: Scene;
    advBackEffects: AdvSceneLayer | null;
    filterBackground?: (target: WebGLRenderTarget) => void;
  };
  private readonly postFinishOptions: {
    timeSeconds: number;
    foreground: AdvSceneLayer | null;
    commandEffects: AdvSceneLayer | null;
    uiEffects: AdvSceneLayer | null;
    filterStage?: (target: WebGLRenderTarget) => void;
    beforePostProcessing?: (target: WebGLRenderTarget) => void;
  } = { timeSeconds: 0, foreground: null, commandEffects: null, uiEffects: null };
  private readonly adaptiveRenderQuality: AdaptiveRenderQuality;
  private readonly qualityConfig: AdvQualityConfig;
  private readonly cameraTweenVersions: Record<string, number> = {};
  private backgroundShake: Vec2 = { x: 0, y: 0 };
  private characterShake: Vec2 = { x: 0, y: 0 };
  private readonly commandShakeControllers = new Map<"background" | "character" | "still" | "talk", AbortController>();
  private cameraShake: Vec2 = { x: 0, y: 0 };
  private cameraShakeMode: "idle" | "playing" | "stopping" = "idle";
  private cameraShakeCycleElapsed = 0;
  private cameraShakeFadeElapsed = 0;
  private cameraShakeFadeSeconds = 0;
  private cameraShakeWeight = 0;
  private cameraShakeStrength = 0;
  private cameraShakeCycleSeconds = 1;
  private cameraShakeVibrato = 2;
  private cameraShakeRandomness = 60;
  private cameraShakePath: ReturnType<typeof createAdvDotweenShakePath> | null = null;
  private cameraShakeCycleStart: Vec2 = { x: 0, y: 0 };
  private cameraShakeWaitNextCycle = false;
  private cameraShakeFadeController: AbortController | null = null;
  private cameraShakeStopPromise: Promise<void> | null = null;
  private commandPostEffect: unknown = null;
  private readonly commandVolumes = new Map<string, CommandVolumeState>();
  private stagePostEffect: UnknownRecord | null = null;
  private stageLightState: UnknownRecord | null = null;
  private characterLightingState: UnityCharacterLightingState = DEFAULT_UNITY_CHARACTER_LIGHTING;
  private stageMultiplyTextureVersion = 0;
  private stageMultiplyTextureUrl = "";
  private stageMultiplyTextureOptions: ThreeRendererMultiplyTextureOptions = {};
  private focusDataSettingsKey = "Settings-Default";
  private frameEpoch = 0;
  private pendingStageCapture: PendingStageCapture | null = null;
  private stageCaptureAlpha = 0;
  private stageCaptureGeneration = 0;
  private deterministicReplayActive = false;
  private contextLost = false;
  private contextRestoreGeneration = 0;
  private contextRestoreController: ContextRestoreController | null = null;
  private seekIndexCompilationActive = false;
  private contextRestoreWatchdog: ReturnType<typeof setTimeout> | undefined;

  /**
   * A restore whose model rebuild never settles would leave the controller
   * set forever; the character update loop breaks on it every frame, so every
   * character turns into a permanent static image while the rest of the scene
   * keeps rendering. Complete a stale restore so characters can recover.
   */
  private armContextRestoreWatchdog(controller: ContextRestoreController): void {
    this.clearContextRestoreWatchdog();
    this.contextRestoreWatchdog = setTimeout(() => {
      this.contextRestoreWatchdog = undefined;
      if (this.destroyed || this.contextRestoreController !== controller) return;
      console.error("[ThreeStoryScene] WebGL context restore did not complete; releasing the character gate");
      this.completeContextRestore(controller);
    }, 30_000);
  }

  private clearContextRestoreWatchdog(): void {
    if (this.contextRestoreWatchdog !== undefined) {
      clearTimeout(this.contextRestoreWatchdog);
      this.contextRestoreWatchdog = undefined;
    }
  }
  private contextRestoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly contextReadyWaiters = new Set<(ready: boolean) => void>();
  private readonly characterModelRecoveryStates = new Map<StoryCharacter, CharacterModelRecoveryState>();
  private readonly sceneUpdateFailureStates = new Map<string, SceneUpdateFailureState>();
  private renderFailureCount = 0;
  private renderRetryAtSeconds = 0;
  private destroyed = false;
  private transitionController = new AbortController();
  private sceneGeneration = 0;
  private stillGeneration = 0;
  private readonly stillOperations = new Map<string, number>();
  private stillOperationSerial = 0;
  private readonly lifecycleController = new AbortController();
  // Global monotonic allocation prevents an ABA race when teardown or a target
  // replacement clears the map while an older provider load is still resolving.
  private characterLoadSequence = 0;
  private readonly characterLoadTokens = new Map<string, number>();
  private readonly pendingCharacterCommands = new PendingCharacterCommands();
  private readonly context: StorySceneBackendContext;
  private readonly resources: StoryResourceResolver;
  private readonly textureCache: SharedTextureResourceCache<string, Texture>;
  private readonly episodeTextureLeases = new Map<string, SharedTextureLease<Texture>>();
  private readonly episodeVideoRenderables = new Map<string, { readonly url: string; readonly release: () => void }>();
  private readonly episodeVideoRenderableLoads = new Map<
    string,
    Promise<{ readonly url: string; readonly release: () => void }>
  >();
  private readonly characterProviders: readonly ThreeCharacterProvider[];
  private readonly characterModelDisposers = new WeakMap<ThreeStoryCharacterModel, () => Promise<void>>();
  private readonly disposedCharacterModels = new WeakSet<ThreeStoryCharacterModel>();
  private readonly pendingCharacterDisposals = new Set<Promise<void>>();
  private readonly staticPortraitFallback: boolean;
  private readonly colorGradingMode: AdvColorGradingPipelineMode;
  private detachHostAbort: () => void = () => undefined;
  private characterAlphaOperationSequence = 0;
  private readonly characterAlphaOperations = new Map<string, number>();
  private readonly characterPresentationHistory = new Map<string, AdvCharacterPresentationEvent[]>();
  private characterPriorityOrder: number[] = [4, 0, 3, 1, 2];
  private playbackSpeedRate = 1;
  private readonly playbackSpeedEvents: Array<{ readonly rate: number; readonly queuedAtSeconds: number }> = [];

  constructor(context: StorySceneBackendContext, options: ThreeStorySceneOptions = {}) {
    this.context = context;
    this.screenEffects = new StoryScreenEffects(
      context.signal,
      async (definition, signal) => {
        const contribution = context.rendererExtensions?.effects.find(
          (effect) => effect.effectType === definition.effectType,
        );
        if (!contribution) throw new Error(`Screen effect provider is unavailable: ${definition.effectType}`);
        const renderer = this.renderer;
        if (!renderer) throw new Error("The renderer is not ready for screen effects");
        const effect = await contribution.create(
          definition,
          {
            renderer: this.rendererId,
            rendererContext: this.createRendererContext(renderer, renderer.getContext() as WebGL2RenderingContext),
            runtime: this.runtime,
            state: this.state,
            resources: this.resources,
            signal,
            service: (key) => context.rendererExtensions?.service(key),
          },
          signal,
        );
        if (!isStoryScreenSpriteEffect(effect)) {
          await disposeVegaDisposable(effect);
          throw new TypeError("The effect provider does not expose screen sprites");
        }
        return effect;
      },
      () => this.syncScreenEffects(),
    );
    this.screenFilterProvider = context.rendererExtensions?.service(STORY_SCREEN_FILTER_PROVIDER);
    this.screenTransformChannels = Object.freeze([
      ...new Set([
        "x",
        "y",
        "scaleX",
        "scaleY",
        "rotation",
        "alpha",
        "brightness",
        ...(this.screenFilterProvider?.channels ?? []),
      ]),
    ]);
    this.rendererId = options.rendererId ?? VEGA_THREE_RENDERER_ID;
    this.backend = this.rendererId;
    this.profile = options.profile ?? "vega";
    this.runtime = mergeAdvRuntime(context.runtime);
    this.qualityConfig = new AdvQualityConfig(this.runtime.quality);
    this.adaptiveRenderQuality = new AdaptiveRenderQuality({
      enabled: this.runtime.adaptiveRenderScaleEnabled,
      initialScale: 1,
      minScale: finite(this.runtime.adaptiveRenderScaleMin, 0.72),
      maxScale: 1,
      targetFps: finite(this.runtime.targetFrameRate, 60),
    });
    this.state = context.state;
    this.resources = context.resources;
    this.commandEffects = new UnityParticleEffectController({
      resources: this.resources,
      signal: this.lifecycleController.signal,
      onNaturalComplete: (key) => this.commandEffectStates.delete(key),
    });
    this.stageEffects = new UnityParticleEffectController({
      resources: this.resources,
      signal: this.lifecycleController.signal,
    });
    this.textureCache = textureCacheFor(this.resources);
    this.textureCache.configure(Math.max(8, Math.trunc(finite(this.runtime.textureCacheEntryMax, 48))));
    this.characterProviders = [...(context.characterProviders ?? [])] as unknown as readonly ThreeCharacterProvider[];
    this.staticPortraitFallback = options.staticPortraitFallback ?? true;
    this.colorGradingMode = options.colorGradingMode ?? "ldr";
    const abortFromHost = () => this.lifecycleController.abort(context.signal.reason);
    if (context.signal.aborted) abortFromHost();
    else {
      context.signal.addEventListener("abort", abortFromHost, { once: true });
      this.detachHostAbort = () => context.signal.removeEventListener("abort", abortFromHost);
    }
    const initialCameraPosition = vec3(this.runtime.stage.initialCameraPosition, ZERO_VEC3);
    const initialCameraRotation = vec3(this.runtime.stage.initialCameraRotation, ZERO_VEC3);
    this.cameraState.baseX = initialCameraPosition.x;
    this.cameraState.baseY = initialCameraPosition.y;
    this.cameraState.baseZ = initialCameraPosition.z;
    this.cameraState.rotationX = -initialCameraRotation.x;
    this.cameraState.rotationY = initialCameraRotation.y;
    this.cameraState.angle = initialCameraRotation.z;
    this.postBeginOptions = {
      clearColor: 0x000000,
      clearAlpha: 0,
      captureStage: false,
      stageCaptureScene: this.backgroundCaptureScene,
      advBackEffects: null,
    };
    this.scene.name = "Unity ADV Scene";
    this.backgroundField.name = "AdvBackgroundField";
    this.backgroundCaptureScene.name = "Unity ADV AdvBack Capture Scene";
    this.backgroundCaptureField.name = "AdvBackgroundCaptureField";
    this.commandAdvBackScene.name = "Unity ADV Command AdvBack Effects";
    this.commandAdvFrontScene.name = "Unity ADV Command AdvFront Effects";
    this.commandUiScene.name = "Unity ADV Command UI Effects";
    this.characterField.name = "AdvCharacterField";
    this.foregroundField.name = "AdvForegroundField";
    this.scene.add(this.backgroundField, this.characterField, this.foregroundField);
    this.backgroundCaptureScene.add(this.backgroundCaptureField);
    this.backgroundField.visible = false;
    this.backgroundCaptureField.visible = false;
    // AdvBackgroundField/BaseRenderer is Unity's built-in 10x10 Plane at
    // local (0, 0, +1), rotated -90 degrees and scaled by five. Converting
    // Unity Z to Three puts the opaque black 50x50 backing plane at -1,
    // immediately behind the stage sprite. ScreenCaptureRenderPass redraws
    // this renderer together with the sprite because both are on AdvBack.
    for (const [mesh, field] of [
      [this.backgroundBaseMesh, this.backgroundField],
      [this.backgroundCaptureBaseMesh, this.backgroundCaptureField],
    ] as const) {
      mesh.name = "AdvBackgroundBaseRenderer";
      mesh.position.set(0, 0, -1);
      mesh.scale.setScalar(50);
      mesh.renderOrder = 0;
      field.add(mesh);
    }
    this.camera.matrixAutoUpdate = true;
  }

  async setup(mount: HTMLElement): Promise<void> {
    if (this.renderer) return;
    if (this.destroyed) throw sceneAbortError("A destroyed story scene cannot be set up again");
    this.mount = mount;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      alpha: false,
      // The Unity ADV field targets have samples=0. High/Best enables URP's
      // FinalPost FXAA, not default-framebuffer MSAA.
      antialias: false,
      depth: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!context) throw new Error("The Three story player requires WebGL2");
    const fieldTargetFormat = detectAdvFieldTargetFormat(context);
    canvas.dataset.advFieldTargetFormat = fieldTargetFormat.precision;
    this.renderer = new WebGLRenderer({ canvas, context, antialias: false, alpha: false });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.autoClear = false;
    canvas.className = "adv-story-canvas adv-story-canvas-three";
    Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
    canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
    mount.appendChild(canvas);
    this.pipeline = new AdvPostPipeline(this.renderer, {
      finalPostFxaaEnabled: this.qualityConfig.isCameraAntiAliasingEnabled(),
      fieldTargetFormat,
      colorGradingMode: this.colorGradingMode,
      resolvePostTexture: (reference, usage) =>
        this.context.rendererExtensions?.service(THREE_POST_TEXTURE_RESOLVER)?.resolve(reference, usage) ?? null,
    });
    this.overlay = new StoryDomOverlay(
      mount,
      this.renderer,
      (source) => this.acquireTexture(source),
      this.context.rendererExtensions?.service(STORY_FRAME_LAYOUT_PROVIDER),
    );
    this.overlay.canvasPass.setStillSpeed(this.playbackSpeedRate);
    this.ruleTransitionPass = new AdvRuleTransitionPass(this.renderer);
    // Always observe: fullscreen, rotation, and mobile browser chrome
    // changes resize the mount. Without this the WebGL canvas keeps its
    // pre-change dimensions and renders a black surface on Android.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(mount);
    this.resize();
    this.previousFrameTime = performance.now();
    this.targetFrameClock.reset();
    this.settleContextReadyWaiters(true);
    this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
  }

  private rendererResourcePreparationContext(
    story: AdvStory,
    signal: AbortSignal,
  ): StoryRendererResourcePreparationContext {
    return {
      renderer: this.rendererId,
      story,
      runtime: this.runtime,
      state: this.state,
      resources: this.resources,
      signal,
      service: (key) => this.context.rendererExtensions?.service(key),
    };
  }

  private storyRendererEffects(story: AdvStory): readonly {
    readonly contribution: StoryRendererEffectContribution;
    readonly definition: Readonly<Record<string, unknown>>;
  }[] {
    const effects: Array<{
      readonly contribution: StoryRendererEffectContribution;
      readonly definition: Readonly<Record<string, unknown>>;
    }> = [];
    for (const command of iterateAdvCommands(story.commands ?? [])) {
      const effect = command.effect;
      if (!effect) continue;
      const contribution = this.effectContribution(effect);
      if (!contribution) continue;
      effects.push({
        contribution,
        definition:
          effect.runtime && typeof effect.runtime === "object"
            ? effect.runtime
            : (effect as Readonly<Record<string, unknown>>),
      });
    }
    return effects;
  }

  async prepareStoryResources(story: AdvStory, signal: AbortSignal = this.lifecycleController.signal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    await this.context.rendererExtensions
      ?.service(THREE_POST_TEXTURE_RESOLVER)
      ?.preload?.(storyPostTextureRequests(story), signal);
    const effects = this.storyRendererEffects(story);
    const contributions = [...new Set(effects.map(({ contribution }) => contribution))];
    const context = this.rendererResourcePreparationContext(story, signal);
    await Promise.all(contributions.map((contribution) => contribution.prepareStoryResources?.(context)));
    if (signal.aborted) throw signal.reason;
  }

  async enumerateStoryResources(
    story: AdvStory,
    signal: AbortSignal = this.lifecycleController.signal,
  ): Promise<readonly StoryResourceDeclaration[]> {
    if (signal.aborted) throw signal.reason;
    const context = this.rendererResourcePreparationContext(story, signal);
    const groups = await Promise.all(
      this.storyRendererEffects(story).map(async ({ contribution, definition }) => {
        if (!contribution.enumerateEffectResources) return [] as const;
        const resources = await contribution.enumerateEffectResources(definition, context);
        return normalizeStoryResourceDeclarations(resources, `renderer effect ${contribution.id}`);
      }),
    );
    if (signal.aborted) throw signal.reason;
    return Object.freeze(groups.flat());
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.destroyed) return;
    this.contextLost = true;
    this.contextRestoreGeneration += 1;
    this.discardAllSpeculativeCharacters("WebGL context lost");
    this.cancelContextRestoreRetry();
    this.cancelContextRestore();
    this.cancelAllCharacterModelRecoveries();
    this.sceneUpdateFailureStates.clear();
    this.renderFailureCount = 0;
    this.renderRetryAtSeconds = 0;
    this.pipeline?.abortFrame();
    this.targetFrameClock.reset();
  };

  private readonly handleContextRestored = (): void => {
    this.beginContextRestore(1);
  };

  private beginContextRestore(attempt: number): void {
    const renderer = this.renderer;
    if (this.destroyed || !renderer) return;
    this.cancelContextRestoreRetry();
    const generation = ++this.contextRestoreGeneration;
    this.contextLost = true;
    this.cancelContextRestore();
    this.cancelAllCharacterModelRecoveries();
    const controller = new AbortController();
    const restoreController: ContextRestoreController = {
      controller,
      detach: this.bindControllerToSignal(controller, this.lifecycleController.signal),
    };
    this.contextRestoreController = restoreController;
    this.armContextRestoreWatchdog(restoreController);
    void (async () => {
      let ownedItems: readonly StoryCharacter[] = [];
      let failures: readonly CharacterGraphicsRestoreFailure[] = [];
      let infrastructureError: unknown = null;
      try {
        ownedItems = await this.releaseInvalidCharacterGraphics();
        this.renderFailureCount = 0;
        this.renderRetryAtSeconds = 0;
        this.previousFrameTime = performance.now();
        this.targetFrameClock.reset();
        // The framebuffer and shared shader context are usable again. Resume
        // healthy scene layers immediately while character GPU resources rebuild
        // independently; one slow model must not blank the entire story surface.
        this.contextLost = false;
        this.resize();
        this.syncPostPipeline();
        failures = await this.restoreCharacterGraphics(generation, ownedItems, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          this.contextLost = true;
          infrastructureError = error;
          console.error(`[ThreeStoryScene] WebGL context restore failed (attempt ${attempt}); retrying`, error);
        }
      } finally {
        const current =
          !this.destroyed &&
          !controller.signal.aborted &&
          generation === this.contextRestoreGeneration &&
          this.contextRestoreController === restoreController;
        this.completeContextRestore(restoreController);
        if (!current) return;
        if (infrastructureError) {
          this.scheduleContextRestoreRetry(attempt + 1);
          return;
        }
        this.contextLost = false;
        this.previousFrameTime = performance.now();
        this.targetFrameClock.reset();
        const now = this.monotonicSeconds();
        for (const failure of failures) {
          if (!this.ownsCharacterController(failure.item)) continue;
          this.requestCharacterModelRecovery(failure.item, failure.error, now, true);
        }
        this.settleContextReadyWaiters(true);
      }
    })();
  }

  private isRenderableContextReady(): boolean {
    const renderer = this.renderer;
    return Boolean(
      renderer &&
      !this.destroyed &&
      !this.contextLost &&
      !this.contextRestoreController &&
      !renderer.getContext().isContextLost(),
    );
  }

  private isRenderableContextGenerationCurrent(generation: number): boolean {
    return generation === this.contextRestoreGeneration && this.isRenderableContextReady();
  }

  private waitForRenderableContext(signal: AbortSignal): Promise<boolean> {
    if (this.isRenderableContextReady()) return Promise.resolve(true);
    if (this.destroyed || signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        this.contextReadyWaiters.delete(finish);
        signal.removeEventListener("abort", abort);
        resolve(ready && this.isRenderableContextReady());
      };
      const abort = (): void => finish(false);
      this.contextReadyWaiters.add(finish);
      signal.addEventListener("abort", abort, { once: true });
      // Avoid missing a restore that completed between the initial check and
      // waiter registration in this same task turn.
      if (signal.aborted) abort();
      else if (this.isRenderableContextReady()) finish(true);
    });
  }

  private settleContextReadyWaiters(ready: boolean): void {
    for (const settle of [...this.contextReadyWaiters]) settle(ready);
  }

  private scheduleContextRestoreRetry(attempt: number): void {
    if (this.destroyed) return;
    this.cancelContextRestoreRetry();
    const delayMilliseconds = Math.min(4000, 125 * 2 ** Math.min(5, Math.max(0, attempt - 2)));
    this.contextRestoreRetryTimer = setTimeout(() => {
      this.contextRestoreRetryTimer = null;
      if (!this.destroyed && this.contextLost) this.beginContextRestore(attempt);
    }, delayMilliseconds);
  }

  private cancelContextRestoreRetry(): void {
    if (this.contextRestoreRetryTimer == null) return;
    clearTimeout(this.contextRestoreRetryTimer);
    this.contextRestoreRetryTimer = null;
  }

  private cancelContextRestore(): void {
    const active = this.contextRestoreController;
    if (!active) return;
    this.contextRestoreController = null;
    active.detach();
    active.controller.abort();
  }

  private completeContextRestore(active: ContextRestoreController): void {
    this.clearContextRestoreWatchdog();
    active.detach();
    if (this.contextRestoreController === active) this.contextRestoreController = null;
  }

  private async releaseInvalidCharacterGraphics(): Promise<StoryCharacter[]> {
    const ownedItems = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const item of this.characterItems.values()) ownedItems.add(item);
    for (const { item } of this.stagedCharacterItems.values()) ownedItems.add(item);
    // Release all owners before any replacement acquires context-keyed GPU
    // resources. Hidden and
    // staged TargetName+Asset controllers keep their logical state: native Out
    // unregisters only the renderer entry, while the Web staging layer bridges
    // the browser-only asynchronous resource window before Show can commit.
    await Promise.all([...ownedItems].map((item) => this.releaseCharacterModelSafely(item, "WebGL context restore")));
    return [...ownedItems];
  }

  private releaseCharacterModelSafely(item: StoryCharacter, reason: string): Promise<void> {
    return this.disposeCharacterModelSafely(item.model, reason, item.target);
  }

  private disposeCharacterModelSafely(
    model: ThreeStoryCharacterModel,
    reason: string,
    target = model.modelUrl,
  ): Promise<void> {
    if (this.disposedCharacterModels.has(model)) return Promise.resolve();
    this.disposedCharacterModels.add(model);
    const providerDisposer = this.characterModelDisposers.get(model);
    this.characterModelDisposers.delete(model);
    let operation: Promise<void>;
    try {
      if (providerDisposer) {
        operation = Promise.resolve(providerDisposer());
      } else {
        operation = Promise.resolve(model.release());
      }
    } catch (error) {
      console.warn(`[ThreeStoryScene] character ${target} release failed during ${reason}`, error);
      return Promise.resolve();
    }
    const settled = operation.catch((error: unknown) => {
      console.warn(`[ThreeStoryScene] character ${target} async disposal failed during ${reason}`, error);
    });
    this.pendingCharacterDisposals.add(settled);
    void settled.finally(() => this.pendingCharacterDisposals.delete(settled));
    return settled;
  }

  private async restoreCharacterGraphics(
    generation: number,
    ownedItems: readonly StoryCharacter[],
    signal: AbortSignal,
  ): Promise<readonly CharacterGraphicsRestoreFailure[]> {
    const failures: CharacterGraphicsRestoreFailure[] = [];
    await Promise.all(
      ownedItems.map(async (item) => {
        let replacement: ThreeStoryCharacterModel | null = null;
        const expectedModel = item.model;
        // WebGL restores the context object, not its user-created textures,
        // programs, VAOs or provider-owned renderer objects.
        try {
          replacement = await this.createCharacterModel(item.target, item.entry, signal);
          if (!replacement) throw new Error(`Unable to restore character model ${item.target}`);
          if (
            this.destroyed ||
            signal.aborted ||
            generation !== this.contextRestoreGeneration ||
            !this.ownsCharacterController(item) ||
            item.model !== expectedModel
          ) {
            this.disposeCharacterModelSafely(replacement, "stale context restore", item.target);
            return;
          }
          await this.prepareReplacementCharacterModel(item, replacement, signal);
          if (
            this.destroyed ||
            signal.aborted ||
            generation !== this.contextRestoreGeneration ||
            !this.ownsCharacterController(item) ||
            item.model !== expectedModel
          ) {
            this.disposeCharacterModelSafely(replacement, "stale context restore preparation", item.target);
            return;
          }

          item.model = replacement;
          item.model.setClockSuspended?.(this.deterministicReplayActive);
          this.placementCache.delete(item);
          replacement = null;
          item.updateFailureCount = 0;
          item.updateRetryAtSeconds = 0;
          item.stalledUpdateCount = 0;
          item.drawFailureCount = 0;
          item.drawRetryAtSeconds = 0;
          item.stalledDrawCount = 0;
        } catch (error) {
          if (replacement) {
            this.disposeCharacterModelSafely(replacement, "failed context restore", item.target);
          }
          if (!signal.aborted && generation === this.contextRestoreGeneration) failures.push({ item, error });
        }
      }),
    );
    return failures;
  }

  private async prepareReplacementCharacterModel(
    item: StoryCharacter,
    replacement: ThreeStoryCharacterModel,
    signal: AbortSignal,
  ): Promise<void> {
    await this.configureModelMultiplyTexture(replacement, this.stageMultiplyTextureVersion);
    if (signal.aborted) throw sceneAbortError(`Character ${item.target} recovery was aborted`);
    await Promise.all([
      ...[...item.warmedMotionNames].map((name) => replacement.prepareMotion(name)),
      ...[...item.warmedExpressionNames].map((name) => replacement.prepareExpression(name)),
    ]);
    if (signal.aborted) {
      throw sceneAbortError(`Character ${item.target} recovery was aborted`);
    }
    const desiredChannels = (): { motionName: string; expressionName: string } => {
      const presentation = this.characterPresentationHistory.get(item.target) || [];
      const latestMotion = [...presentation].reverse().find((event) => event.kind === "motion")?.name;
      const latestExpression = [...presentation].reverse().find((event) => event.kind === "expression")?.name;
      return {
        motionName: firstString(
          item.currentMotionName,
          latestMotion,
          item.entry.profile?.defaultMotionName,
          record(item.entry.runtime).defaultMotionName,
        ),
        expressionName: firstString(
          item.activeExpressionName,
          latestExpression,
          item.entry.profile?.defaultExpressionName,
          record(item.entry.runtime).defaultExpressionName,
        ),
      };
    };
    let prepared = desiredChannels();
    // Coalesce commands that arrive during I/O, but never let rapid authoring or
    // autoplay changes starve installation. playMotion/playExpression retain the
    // latest request and lazy-load it if the final snapshot was not prewarmed.
    for (let pass = 0; pass < CHARACTER_MODEL_RECOVERY_PREPARE_MAX_PASSES; pass += 1) {
      await Promise.all([
        prepared.motionName ? replacement.prepareMotion(prepared.motionName) : Promise.resolve(false),
        prepared.expressionName ? replacement.prepareExpression(prepared.expressionName) : Promise.resolve(false),
      ]);
      if (signal.aborted) throw sceneAbortError(`Character ${item.target} recovery was aborted`);
      const latest = desiredChannels();
      if (latest.motionName === prepared.motionName && latest.expressionName === prepared.expressionName) {
        prepared = latest;
        break;
      }
      prepared = latest;
    }
    // No await is allowed from here through primeInitialFrame. Commands may be
    // dispatched while resources are loading, so this synchronous commit must
    // sample the newest controller state rather than install an older request.
    replacement.setMotionSpeed(this.playbackSpeedRate);
    replacement.setPaused(item.paused);
    const currentMotionName = firstString(item.currentMotionName, prepared.motionName);
    const activeExpressionName = firstString(item.activeExpressionName, prepared.expressionName);
    if (currentMotionName) replacement.playMotion(currentMotionName, item.currentMotionFadeInSeconds ?? 0);
    if (activeExpressionName) {
      replacement.playExpression(activeExpressionName, item.activeExpressionFadeInSeconds ?? 0);
    }
    replacement.primeInitialFrame(this.characterParameterFrame(item, replacement));
  }

  async destroy(options: { releaseTextures?: boolean } = {}): Promise<void> {
    if (this.destroyed) {
      // Natural story completion tears the scene down with retention enabled;
      // a later route unmount must still be able to upgrade that decision.
      if (options.releaseTextures !== false) {
        if (this.resources) this.textureCache.disposeAllWhenIdle();
        else this.textureCache.disposeWhenIdle(this.textureCacheKeys);
        this.textureCacheKeys.clear();
      }
      await Promise.all([...this.pendingCharacterDisposals]);
      await Promise.all([...this.pendingRendererEffectOperations]);
      return;
    }
    this.destroyed = true;
    this.detachHostAbort();
    this.detachHostAbort = () => undefined;
    this.settleContextReadyWaiters(false);
    this.sceneGeneration += 1;
    this.resetShakeState();
    this.cancelContextRestoreRetry();
    this.cancelContextRestore();
    this.cancelAllCharacterModelRecoveries();
    this.sceneUpdateFailureStates.clear();
    this.lifecycleController.abort();
    this.cancelPendingStageCapture(true);
    this.characterLoadTokens.clear();
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelBackgroundBlurTween();
    this.clearCharacters();
    this.commandEffects.dispose();
    this.stageEffects.dispose();
    this.stopRendererExtensionEffects("scene destroy");
    this.screenEffects.dispose();
    this.screenSprites?.dispose();
    this.screenSprites = undefined;
    this.commandEffectStates.clear();
    this.backgroundMesh?.material.dispose();
    this.backgroundMesh = null;
    this.backgroundCaptureMesh?.removeFromParent();
    this.backgroundCaptureMesh?.material.dispose();
    this.backgroundCaptureMesh = null;
    this.backgroundTextureLease?.release();
    this.backgroundTextureLease = null;
    this.backgroundBaseMaterial.dispose();
    this.backgroundCaptureBaseMaterial.dispose();
    this.backgroundGeometry.dispose();
    this.pipeline?.dispose();
    this.screenFilterRunner?.dispose();
    this.screenFilterRunner = undefined;
    for (const entry of this.screenFilters.values()) entry.controller.dispose();
    this.screenFilters.clear();
    this.pipeline = null;
    this.clearRuleTransition();
    this.ruleTransitionPass?.dispose();
    this.ruleTransitionPass = null;
    this.overlay?.destroy();
    this.overlay = null;
    this.releaseEpisodeVideoRenderables();
    this.releaseEpisodeTextureLeases();
    const renderer = this.renderer;
    const canvas = renderer?.domElement;
    canvas?.removeEventListener("webglcontextlost", this.handleContextLost, false);
    canvas?.removeEventListener("webglcontextrestored", this.handleContextRestored, false);
    renderer?.dispose();
    // Story surfaces are never reused after destroy. Explicitly release the
    // browser context so repeated backward seeks cannot accumulate inactive
    // WebGL contexts until the browser's global limit is reached.
    renderer?.forceContextLoss();
    this.renderer = null;
    canvas?.remove();
    this.mount = null;
    if (options.releaseTextures !== false) {
      // A host resolver is the texture-cache lifetime boundary. Successive
      // scenes created for restart/seek share it, so the final owner must also
      // release preload-only entries recorded by an earlier retained scene.
      if (this.resources) this.textureCache.disposeAllWhenIdle();
      else this.textureCache.disposeWhenIdle(this.textureCacheKeys);
      this.textureCacheKeys.clear();
    }
    await Promise.all([...this.pendingCharacterDisposals]);
    await Promise.all([...this.pendingRendererEffectOperations]);
  }

  detachState(state: AdvPlayerState): void {
    this.state = state;
  }

  resize(): void {
    if (!this.mount || !this.renderer || !this.pipeline) return;
    // CSS rotation changes getBoundingClientRect() to the transformed AABB.
    // Rendering must follow the mount's untransformed layout box instead.
    const surfaceWidth = Math.max(1, Math.round(this.mount.clientWidth || 1));
    const surfaceHeight = Math.max(1, Math.round(this.mount.clientHeight || surfaceWidth / (13 / 6)));
    const displayPortrait =
      globalThis.matchMedia?.("(orientation: portrait)").matches ??
      (globalThis.innerHeight || surfaceHeight) > (globalThis.innerWidth || surfaceWidth);
    const targetAspect = unityAdvOrientedTargetAspect(
      displayPortrait,
      surfaceWidth,
      surfaceHeight,
      finite(this.runtime.layout.designViewportAspect, 16 / 9),
      finite(this.runtime.layout.portraitTargetAspect, 16 / 9),
      positiveFinite(this.runtime.layout.landscapeTargetAspect),
    );
    const viewport = createUnityAdvViewport(surfaceWidth, surfaceHeight, targetAspect);
    const x = viewport.x * surfaceWidth;
    const y = viewport.y * surfaceHeight;
    const width = Math.max(1, viewport.width * surfaceWidth);
    const height = Math.max(1, viewport.height * surfaceHeight);
    const requestedDpr = Math.min(
      Math.max(1, globalThis.devicePixelRatio || 1) *
        clamp(this.runtime.rendererResolutionScale, 0.5, 2) *
        this.adaptiveRenderQuality.scale,
      Math.max(1, finite(this.runtime.rendererResolutionMax, 3)),
    );
    const pixelCountMax = Math.max(1, finite(this.runtime.rendererPixelCountMax, 10_000_000));
    const pixelLimitedDpr = Math.sqrt(pixelCountMax / Math.max(1, width * height));
    const dpr = Math.max(0.5, Math.min(requestedDpr, pixelLimitedDpr));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    Object.assign(this.renderer.domElement.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    this.pipeline.setSize(width, height, dpr);
    this.overlay?.setViewport(x, y, width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    Object.assign(this.state.viewport, {
      x,
      y,
      width,
      height,
      surfaceWidth,
      surfaceHeight,
    });
  }

  reservePreloadedTextures(count: number): void {
    this.textureCache.configure(
      Math.max(8, Math.trunc(finite(this.runtime.textureCacheEntryMax, 48)), Math.trunc(finite(count))),
    );
  }

  async preloadTexture(url: string, signal?: AbortSignal): Promise<Texture> {
    const resident = this.episodeTextureLeases.get(url);
    if (resident) return resident.value;
    const lease = await this.acquireTexture(url, signal);
    try {
      await this.uploadPreloadedTexture(lease.value, signal);
      const existing = this.episodeTextureLeases.get(url);
      if (existing) {
        lease.release();
        return existing.value;
      }
      this.episodeTextureLeases.set(url, lease);
      return lease.value;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async preloadVideo(url: string, signal?: AbortSignal): Promise<void> {
    const overlay = this.overlay;
    if (!overlay) throw sceneAbortError("Video preload overlay is unavailable");
    const renderable = await this.resolveEpisodeVideoRenderable(url, signal);
    await overlay.preloadVideo(url, renderable.url, signal);
  }

  async preloadResource(url: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.resources?.canLoad(url)) return false;
    if (this.resources.loadSharedBytes) {
      await this.resources.loadSharedBytes(url, signal);
    } else {
      await this.resources.load(url, signal);
    }
    return true;
  }

  async preloadCharacter(request: StoryCharacterPreloadRequest, signal?: AbortSignal): Promise<boolean> {
    const cmd = request.command;
    const target = firstString(cmd.targetName, cmd.targets?.[0]?.target, cmd.characterKey);
    const entry = cmd.characterModel as StoryCharacterEntry | undefined;
    if (!target || !entry) return false;
    const identity = firstString(record(cmd).controllerIdentity, `${target}\u0000${Number(cmd.targetAssetIndex) || 0}`);
    // CharacterIn synchronously registers its pending ownership before its
    // first await. Do not start a competing speculative construction in the
    // small interval between the loader pump and the command-owned load.
    for (const pending of this.pendingCharacterPlacements.values()) {
      if (pending.identity === identity) return false;
    }
    if (this.cachedCharacterControllers.has(identity)) return true;
    let active = this.characterPreloads.get(identity);
    if (active) {
      return Boolean(await active.promise);
    }
    // Resident Cubism models dominate story memory (multi-page 4096px atlases
    // per model). Episodes that register many characters and swap costumes
    // all story long used to keep every authored controller resident, which
    // froze heavy desktops and jetsam-killed iOS WebContent during loading.
    // Cap total residents; overflow defers to on-demand creation at In.
    // Resident preloads are bounded; overflow defers instantly to on-demand
    // creation at the authored In. Waiting here wedged the loader pump: the
    // pump drains every warmup serially, so one capacity wait stalls all
    // remaining tasks behind owners that may never release.
    const cacheCap = Math.max(
      1,
      Math.min(
        Math.floor(finite(this.runtime.characterPreloadCacheMax, 6)),
        Math.floor(finite(request.episodeControllerCount, 6)),
      ),
    );
    if (this.cachedCharacterControllers.size + this.characterPreloads.size >= cacheCap) {
      this.evictIdleResidentControllers(identity);
      if (this.cachedCharacterControllers.size + this.characterPreloads.size >= cacheCap) {
        console.info("[ThreeStoryScene] character preload deferred at capacity:", identity);
        return true;
      }
    }
    for (const pending of this.pendingCharacterPlacements.values()) {
      if (pending.identity === identity) return false;
    }

    const controller = new AbortController();
    const detachLifecycle = this.bindControllerToSignal(controller, this.lifecycleController.signal);
    const detachCaller = this.bindControllerToSignal(controller, signal);
    const detach = () => {
      detachCaller();
      detachLifecycle();
    };
    let state: CharacterPreloadState;
    const promise = this.createPreloadedCharacter(
      cmd,
      target,
      identity,
      request.positionType,
      request.motions,
      request.expressions,
      request.commandIndex,
      controller.signal,
    ).finally(() => {
      detach();
      if (this.characterPreloads.get(identity) === state) {
        this.characterPreloads.delete(identity);
        this.notifyCharacterPreloadCapacity();
      }
    });
    state = {
      controller,
      detach,
      promise,
      commandIndex: Math.max(0, Math.floor(finite(request.commandIndex))),
    };
    this.characterPreloads.set(identity, state);
    return Boolean(await promise);
  }

  advanceCharacterPreload(_commandIndex: number, _retainBehindCommands: number): readonly string[] {
    // Episode preload reserves every authored controller until the episode is
    // disposed. Playback position must not evict later or previously hidden
    // controllers; this method only reports lifecycle losses (for example a
    // WebGL context reset) so Vega can rebuild them immediately.
    const discarded = [...this.discardedCharacterPreloadIdentities];
    this.discardedCharacterPreloadIdentities.clear();
    return discarded;
  }

  private waitForCharacterPreloadCapacity(signal?: AbortSignal): Promise<void> {
    if (this.destroyed || signal?.aborted || this.lifecycleController.signal.aborted) {
      return Promise.reject(sceneAbortError("Character preload capacity wait was aborted"));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        this.characterPreloadCapacityWaiters.delete(available);
        signal?.removeEventListener("abort", aborted);
        this.lifecycleController.signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const available = () => finish();
      const aborted = () => finish(sceneAbortError("Character preload capacity wait was aborted"));
      this.characterPreloadCapacityWaiters.add(available);
      signal?.addEventListener("abort", aborted, { once: true });
      this.lifecycleController.signal.addEventListener("abort", aborted, {
        once: true,
      });
    });
  }

  private notifyCharacterPreloadCapacity(): void {
    const waiters = [...this.characterPreloadCapacityWaiters];
    this.characterPreloadCapacityWaiters.clear();
    for (const available of waiters) available();
  }

  async loadTexture(url: string, signal?: AbortSignal): Promise<Texture> {
    if (!url) throw new Error("Cannot load an empty ADV texture URL");
    this.textureCacheKeys.add(url);
    return this.withTextureRequestSignal(signal, (requestSignal) => this.textureCache.warm(url, requestSignal));
  }

  private acquireTexture(url: string, signal?: AbortSignal): Promise<SharedTextureLease<Texture>> {
    if (!url) return Promise.reject(new Error("Cannot load an empty ADV texture URL"));
    this.textureCacheKeys.add(url);
    return this.withTextureRequestSignal(signal, (requestSignal) => this.textureCache.acquire(url, requestSignal));
  }

  private async uploadPreloadedTexture(texture: Texture, signal?: AbortSignal): Promise<void> {
    const requestSignal = signal ?? this.lifecycleController.signal;
    if (!(await this.waitForRenderableContext(requestSignal))) {
      throw sceneAbortError("Texture preload was aborted");
    }
    if (requestSignal.aborted) throw sceneAbortError("Texture preload was aborted");
    const renderer = this.renderer;
    if (!renderer || this.destroyed) {
      throw sceneAbortError("Texture preload renderer is unavailable");
    }
    renderer.initTexture(texture);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== "function" || typeof gl.clientWaitSync !== "function") {
      return;
    }
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) return;
    gl.flush();
    try {
      while (!requestSignal.aborted && !this.destroyed) {
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          return;
        }
        if (status === gl.WAIT_FAILED) {
          throw new Error("Texture preload GPU fence failed");
        }
        await nextPreloadPoll(requestSignal);
      }
      throw sceneAbortError("Texture preload was aborted");
    } finally {
      gl.deleteSync(fence);
    }
  }

  private releaseEpisodeTextureLeases(): void {
    for (const lease of this.episodeTextureLeases.values()) lease.release();
    this.episodeTextureLeases.clear();
  }

  private async resolveEpisodeVideoRenderable(
    source: string,
    signal?: AbortSignal,
  ): Promise<{ readonly url: string; readonly release: () => void }> {
    const resident = this.episodeVideoRenderables.get(source);
    if (resident) {
      return waitForScenePromise(Promise.resolve(resident), signal, "Video preload was aborted");
    }
    const pending = this.episodeVideoRenderableLoads.get(source);
    if (pending) {
      return waitForScenePromise(pending, signal, "Video preload was aborted");
    }
    const load = this.resources
      .resolveRenderable(source, this.lifecycleController.signal)
      .then((renderable) => {
        if (this.destroyed) {
          renderable.release();
          throw sceneAbortError("Video preload was aborted");
        }
        const existing = this.episodeVideoRenderables.get(source);
        if (existing) {
          renderable.release();
          return existing;
        }
        this.episodeVideoRenderables.set(source, renderable);
        return renderable;
      })
      .finally(() => {
        if (this.episodeVideoRenderableLoads.get(source) === load) {
          this.episodeVideoRenderableLoads.delete(source);
        }
      });
    this.episodeVideoRenderableLoads.set(source, load);
    return waitForScenePromise(load, signal, "Video preload was aborted");
  }

  private releaseEpisodeVideoRenderables(): void {
    for (const renderable of this.episodeVideoRenderables.values()) {
      renderable.release();
    }
    this.episodeVideoRenderables.clear();
    this.episodeVideoRenderableLoads.clear();
  }

  private withTextureRequestSignal<Value>(
    callerSignal: AbortSignal | undefined,
    request: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    const lifecycleSignal = this.lifecycleController.signal;
    if (!callerSignal || callerSignal === lifecycleSignal) return request(lifecycleSignal);
    const linked = new AbortController();
    const abort = (): void => linked.abort();
    if (callerSignal.aborted || lifecycleSignal.aborted) linked.abort();
    else {
      callerSignal.addEventListener("abort", abort, { once: true });
      lifecycleSignal.addEventListener("abort", abort, { once: true });
      if (callerSignal.aborted || lifecycleSignal.aborted) linked.abort();
    }
    return Promise.resolve()
      .then(() => request(linked.signal))
      .finally(() => {
        callerSignal.removeEventListener("abort", abort);
        lifecycleSignal.removeEventListener("abort", abort);
      });
  }

  setSeekIndexCompilationActive(active: boolean): void {
    if (this.seekIndexCompilationActive === Boolean(active)) return;
    this.seekIndexCompilationActive = Boolean(active);
  }

  setDeterministicReplayActive(active: boolean): void {
    if (this.deterministicReplayActive === active) return;
    this.deterministicReplayActive = active;
    for (const item of new Set(this.cachedCharacterControllers.values()))
      item.model.setClockSuspended?.(active || this.characterItems.get(item.target) !== item);
    this.overlay?.setFrameParticlesPaused(active);
    this.previousFrameTime = performance.now();
    this.targetFrameClock.reset();
  }

  private runTween(options: Parameters<typeof tween>[0]): Promise<void> {
    const lifecycleSignal = this.lifecycleController.signal;
    const transitionSignal = this.transitionController.signal;
    const callerSignal = options.signal;
    const linked = new AbortController();
    const abort = (): void => linked.abort();
    const parents = new Set([lifecycleSignal, transitionSignal, ...(callerSignal ? [callerSignal] : [])]);
    if ([...parents].some((signal) => signal.aborted)) linked.abort();
    else {
      for (const signal of parents) signal.addEventListener("abort", abort, { once: true });
    }
    return tween({ ...options, signal: linked.signal }).finally(() => {
      for (const signal of parents) signal.removeEventListener("abort", abort);
    });
  }

  cancelTransitionsForSeek(): void {
    this.stillGeneration++;
    this.overlay?.canvasPass.cancelStillLoad();
    this.stillOperations.clear();
    this.overlay?.canvasPass.cancelPendingStills();
    this.transitionController.abort();
    this.transitionController = new AbortController();
  }

  presentSeekSnapshot(): void {
    if (!this.renderer || !this.pipeline || this.destroyed || this.contextLost) return;
    this.pipeline.resetTemporalHistory();
    this.render(this.lastRenderedTimeSeconds || this.previousFrameTime / 1000);
  }

  private replaceCharacterTweenController(controllers: Map<string, AbortController>, target: string): AbortController {
    controllers.get(target)?.abort();
    const controller = new AbortController();
    controllers.set(target, controller);
    return controller;
  }

  private releaseCharacterTweenController(
    controllers: Map<string, AbortController>,
    target: string,
    controller: AbortController,
  ): void {
    if (controllers.get(target) === controller) controllers.delete(target);
  }

  private cancelCharacterOwnedTweens(target: string): void {
    this.characterBrightnessTweenControllers.get(target)?.abort();
    this.characterBrightnessTweenControllers.delete(target);
    this.cancelCharacterBlurTween(target);
  }

  private cancelCharacterBlurTween(target: string): void {
    this.characterBlurTweenControllers.get(target)?.abort();
    this.characterBlurTweenControllers.delete(target);
  }

  private cancelAllCharacterOwnedTweens(): void {
    for (const controller of this.characterBrightnessTweenControllers.values()) controller.abort();
    this.characterBrightnessTweenControllers.clear();
    for (const controller of this.characterBlurTweenControllers.values()) controller.abort();
    this.characterBlurTweenControllers.clear();
  }

  private replaceBackgroundBlurTweenController(): AbortController {
    this.backgroundBlurTweenController?.abort();
    const controller = new AbortController();
    this.backgroundBlurTweenController = controller;
    return controller;
  }

  private bindControllerToSignal(controller: AbortController, signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  private cancelBackgroundBlurTween(): void {
    this.backgroundBlurTweenController?.abort();
    this.backgroundBlurTweenController = null;
  }

  capturePreview(options: StoryScenePreviewOptions): string | undefined {
    if (!this.renderer || !this.pipeline || this.destroyed || this.contextLost) return undefined;
    try {
      this.render(this.lastRenderedTimeSeconds || this.previousFrameTime / 1000);
      if (this.renderFailureCount || this.renderer.getContext().isContextLost()) return undefined;
      const source = this.renderer.domElement;
      if (!source.width || !source.height) return undefined;
      const preview = source.ownerDocument.createElement("canvas");
      preview.width = Math.max(1, Math.round(options.width));
      preview.height = Math.max(1, Math.round(options.height));
      const context = preview.getContext("2d");
      if (!context) return undefined;
      const scale = Math.max(preview.width / source.width, preview.height / source.height);
      const width = source.width * scale;
      const height = source.height * scale;
      context.drawImage(source, (preview.width - width) / 2, (preview.height - height) / 2, width, height);
      return preview.toDataURL(options.format, options.quality);
    } catch {
      return undefined;
    }
  }

  private readonly onAnimationFrame = (time: number): void => {
    if (this.destroyed) return;
    try {
      const elapsedMs = time - this.previousFrameTime;
      this.previousFrameTime = time;
      const targetFrameRate = Math.max(1, finite(this.runtime.targetFrameRate, 45));
      const deltaSeconds = this.targetFrameClock.advance(elapsedMs / 1000, targetFrameRate);
      if (deltaSeconds == null) return;
      if (this.deterministicReplayActive) {
        // Asset decode time must not advance character plugin motions/physics or particle
        // clocks—or expose intermediate frames—while a target is assembled.
        this.targetFrameClock.reset();
        return;
      }
      if (this.adaptiveRenderQuality.sample(deltaSeconds * 1000)) this.resize();
      try {
        this.update(deltaSeconds, time / 1000);
      } catch (error) {
        // Keep rendering the last coherent state even if an unforeseen update
        // path escapes its subsystem boundary. Otherwise one deterministic
        // effect fault can make every healthy character appear frozen.
        console.error("[ThreeStoryScene] scene update failed; rendering the current state", error);
      }
      this.render(time / 1000);
    } catch (error) {
      // A browser frame callback is not supervised like Unity's player loop: an
      // escaped exception would otherwise prevent every subsequent animation
      // frame from being scheduled and freeze all characters permanently.
      this.pipeline?.abortFrame();
      console.error("[ThreeStoryScene] animation frame failed; retrying on the next frame", error);
    } finally {
      if (!this.destroyed) this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
    }
  };

  private characterParameterFrame(
    item: StoryCharacter,
    parameterSource: ThreeStoryCharacterModel = item.model,
  ): ThreeCharacterParameterFrame {
    const applyFallbackMouth = item.lipSync.enabled && !item.lipSync.motionSyncPcm;
    const frame = item.parameterFrame;
    frame.angleX = item.angleOverride ? item.angle : undefined;
    frame.bodyAngleX = item.angleOverride ? item.bodyAngle : undefined;
    frame.lookX = item.lookOverride ? finite(item.lookX) : undefined;
    frame.lookY = item.lookOverride ? finite(item.lookY) : undefined;
    frame.mouthOpenY = applyFallbackMouth ? item.lipSync.mouthOpenY : undefined;
    // RMS/timed fallback has no honest vowel classifier. Leave MouthForm
    // authored by the expression; ready MotionSync PCM drives it directly.
    frame.mouthForm = undefined;
    frame.motionSyncPcm = item.lipSync.motionSyncPcm;
    frame.motionSyncWeight = item.lipSync.multiplier;
    frame.blends = this.harmonicBlends(item, parameterSource);
    return frame;
  }

  private update(deltaSeconds: number, timeSeconds = this.monotonicSeconds()): void {
    if (!this.contextRestoreController) {
      this.pumpCharacterModelRecoveries(timeSeconds);
    }
    this.runSceneUpdateSubsystem("screen effects", timeSeconds, () => {
      this.screenEffects.update(deltaSeconds);
      this.syncScreenEffects();
    });
    this.runSceneUpdateSubsystem("canvas layers", timeSeconds, () => this.overlay?.update(deltaSeconds));
    this.runSceneUpdateSubsystem("rule transition", timeSeconds, () => this.ruleTransition.update(deltaSeconds));
    this.runSceneUpdateSubsystem("camera shake", timeSeconds, () => this.updatePersistentCameraShake(deltaSeconds));
    for (const item of this.characterItems.values()) {
      if (this.contextRestoreController) break;
      if (timeSeconds < item.updateRetryAtSeconds) continue;
      try {
        if (!item.model.isOperational) {
          // Released/uninitialized SDK wrappers intentionally no-op instead of
          // throwing. Detect that state explicitly so it cannot masquerade as
          // a healthy but motionless character forever.
          if (!this.contextRestoreController) {
            this.requestCharacterModelRecovery(
              item,
              new Error(`Character ${item.target} model is no longer operational`),
              timeSeconds,
              true,
            );
          }
          continue;
        }
        // Pause freezes the authored motion/expression clocks inside the model,
        // but the character still receives every scene frame. Keeping lip sync,
        // harmonic inputs, blink, physics and Core evaluation alive prevents a
        // stale Pause/Resume latch from becoming a permanent static image.
        this.updateLipSync(item, deltaSeconds);
        item.harmonicTime += deltaSeconds;
        const updateSerial = item.model.updateSerial;
        item.model.update(deltaSeconds, this.characterParameterFrame(item));
        if (item.model.updateSerial === updateSerial) {
          item.stalledUpdateCount += 1;
          if (item.stalledUpdateCount >= CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD) {
            item.stalledUpdateCount = 0;
            this.requestCharacterModelRecovery(
              item,
              new Error(`Character ${item.target} model accepted frames without advancing`),
              timeSeconds,
              true,
            );
          }
          continue;
        }
        item.stalledUpdateCount = 0;
        item.updateFailureCount = 0;
        item.updateRetryAtSeconds = 0;
      } catch (error) {
        this.recordCharacterFrameFailure(item, "update", error, timeSeconds);
      }
    }
    this.runSceneUpdateSubsystem("command effects", timeSeconds, () => this.commandEffects.update(deltaSeconds));
    this.runSceneUpdateSubsystem("stage effects", timeSeconds, () => this.stageEffects.update(deltaSeconds));
    this.runSceneUpdateSubsystem("video state", timeSeconds, () => {
      const video = this.overlay?.videoElement;
      if (!video) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      this.state.video.currentTime = video.currentTime;
      this.state.video.duration = duration;
      this.state.video.progress = duration > 0 ? video.currentTime / duration : 0;
      this.state.video.ended = video.ended;
      this.state.video.playing = !video.paused && !video.ended;
    });
  }

  private runSceneUpdateSubsystem(name: string, timeSeconds: number, update: () => void): void {
    const previous = this.sceneUpdateFailureStates.get(name);
    if (previous && timeSeconds < previous.retryAtSeconds) return;
    try {
      update();
      if (previous) this.sceneUpdateFailureStates.delete(name);
    } catch (error) {
      const failures = (previous?.failures ?? 0) + 1;
      this.sceneUpdateFailureStates.set(name, {
        failures,
        retryAtSeconds: timeSeconds + Math.min(4, 0.125 * 2 ** Math.min(5, failures - 1)),
      });
      if (failures === 1 || (failures & (failures - 1)) === 0) {
        console.error(`[ThreeStoryScene] ${name} update failed (attempt ${failures}); retrying`, error);
      }
    }
  }

  private render(timeSeconds: number): void {
    if (!this.renderer || !this.pipeline) return;
    // A context loss is recoverable by the browser/Three and must not latch a
    // permanent scene fault. Other synchronous renderer/SDK failures are
    // deterministic, so retrying them every animation frame only burns CPU.
    if (this.contextLost || this.renderer.getContext().isContextLost() || timeSeconds < this.renderRetryAtSeconds)
      return;
    this.applyTransforms();
    this.commandEffects.syncAnchors();
    this.stageEffects.syncAnchors();
    const capture = this.pendingStageCapture;
    // pipeline.beginBackground renders the scene before any character plugin draw, and
    // WebGLRenderer updates both scene and camera matrices there. Explicitly
    // traversing the same trees here duplicated that work every frame; effect
    // anchors already update their own parent chain in syncAnchor().
    try {
      const characters = this.sortedCharacterItems;
      characters.length = 0;
      for (const item of this.characterItems.values()) characters.push(item);
      characters.sort(
        (left, right) =>
          right.sortingOrder - left.sortingOrder ||
          this.characterPriority(left.positionType) - this.characterPriority(right.positionType),
      );
      const groupCount = this.contextRestoreController ? 0 : this.characterRenderGroups(characters);
      const beginOptions = this.postBeginOptions;
      beginOptions.captureStage = Boolean(capture);
      beginOptions.advBackEffects = this.effectLayer(this.commandAdvBackScene);
      beginOptions.filterBackground = this.screenFilter("bg-main")?.controller.active
        ? this.filterBackground
        : undefined;
      this.pipeline.beginBackground(this.scene, this.camera, beginOptions);
      if (capture && capture.generation === this.stageCaptureGeneration) {
        this.stageCaptureAlpha = 1;
        this.pendingStageCapture = null;
        capture.resolve(capture.generation);
      }
      this.pipeline.compositeStageCapture(this.stageCaptureAlpha);
      if (this.screenEffects.size) this.pipeline.renderBackgroundOverlay(this.renderScreenBackground);
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
        const group = this.characterRenderGroupPool[groupIndex]!;
        const frame = this.pipeline.beginCharacterGroup(group.settings);
        for (const item of group.items) {
          this.characterProjection(item, this.renderMvp);
          // Unity applies character Alpha/Brightness once in AlphaBlend.shader
          // after the whole adjacent group has been rendered into tempRT.
          this.characterDrawState.objectToWorld = item.surface.matrixWorld;
          this.characterDrawState.timeSeconds = timeSeconds;
          if (timeSeconds >= item.drawRetryAtSeconds) {
            try {
              this.pipeline.prepareCharacterDraw(frame);
              const drawSerial = item.model.drawSerial;
              item.model.draw(
                this.renderMvp,
                frame.framebuffer,
                frame.viewport,
                WHITE_CHARACTER_COLOR,
                this.characterDrawState,
              );
              if (item.model.drawSerial === drawSerial) {
                item.stalledDrawCount += 1;
                if (item.stalledDrawCount >= CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD) {
                  item.stalledDrawCount = 0;
                  this.requestCharacterModelRecovery(
                    item,
                    new Error(`Character ${item.target} model accepted draws without submitting`),
                    timeSeconds,
                    true,
                  );
                }
              } else {
                item.stalledDrawCount = 0;
                item.drawFailureCount = 0;
                item.drawRetryAtSeconds = 0;
              }
            } catch (error) {
              this.renderer.resetState();
              this.recordCharacterFrameFailure(item, "draw", error, timeSeconds);
            }
          }
          const routedEffects = this.commandCharacterScenes.get(item.positionType);
          const characterEffectLayer = routedEffects ? this.effectLayer(routedEffects) : null;
          if (characterEffectLayer) this.pipeline.renderCharacterLayer(characterEffectLayer);
        }
        this.pipeline.finishCharacterGroup(group.settings);
      }
      if (!this.contextRestoreController) this.renderCharacterPrimes(timeSeconds);
      const finishOptions = this.postFinishOptions;
      finishOptions.timeSeconds = timeSeconds;
      finishOptions.foreground = this.stageEffects.layer(this.camera);
      finishOptions.commandEffects = this.effectLayer(this.commandAdvFrontScene);
      finishOptions.uiEffects = this.effectLayer(this.commandUiScene);
      finishOptions.beforePostProcessing = this.screenEffects.size ? this.renderScreenForeground : undefined;
      finishOptions.filterStage = this.screenFilter("stage-main")?.controller.active ? this.filterStage : undefined;
      this.pipeline.finish(finishOptions);
      this.overlay?.render();
      this.ruleTransitionPass?.render(this.ruleTransition.renderState);
      this.lastRenderedTimeSeconds = timeSeconds;
      this.renderFailureCount = 0;
      this.renderRetryAtSeconds = 0;
    } catch (error) {
      const contextLost = this.renderer?.getContext().isContextLost() ?? false;
      if (!contextLost) {
        const count = ++this.renderFailureCount;
        this.renderRetryAtSeconds = timeSeconds + Math.min(4, 0.125 * 2 ** Math.min(5, count - 1));
        if (count === 1 || (count & (count - 1)) === 0) {
          console.error(`[ThreeStoryScene] scene render failed (attempt ${count}); retrying`, error);
        }
      }
      this.pipeline.abortFrame();
    }
  }

  /**
   * Submit one invisible draw for every newly prepared controller. Model
   * construction alone does not prove renderer readiness: Cubism masks and
   * shaders, Spine pipelines and portrait programs may all perform their last
   * GPU work on the first draw. The isolated alpha-zero group compiles/uploads
   * that work without changing the composed scene.
   */
  private renderCharacterPrimes(timeSeconds: number): void {
    if (!this.pipeline || !this.renderer || !this.characterRenderPrimes.size) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const candidates: CharacterRenderPrimeState[] = [];
    for (const state of [...this.characterRenderPrimes.values()]) {
      if (!this.isRenderableContextGenerationCurrent(state.contextGeneration)) {
        this.settleCharacterRenderPrime(state, new Error("Graphics context changed before character first draw"));
        continue;
      }
      if (state.fence) {
        const status = gl.clientWaitSync(state.fence, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          this.settleCharacterRenderPrime(state);
        } else if (status === gl.WAIT_FAILED) {
          this.settleCharacterRenderPrime(
            state,
            new Error(`Character ${state.item.target} renderer-ready fence failed`),
          );
        }
        continue;
      }
      candidates.push(state);
    }
    if (!candidates.length) return;

    const settings = {
      blur: 0,
      alpha: 0,
      brightness: 1,
      radiusMax: 0,
    };
    const frame = this.pipeline.beginCharacterGroup(settings);
    const completed: CharacterRenderPrimeState[] = [];
    const failed: Array<{
      readonly state: CharacterRenderPrimeState;
      readonly error: unknown;
    }> = [];
    for (const state of candidates) {
      try {
        const { item } = state;
        this.layoutCharacter(item);
        item.node.updateWorldMatrix(true, false);
        this.renderMvp
          .copy(this.camera.projectionMatrix)
          .multiply(this.camera.matrixWorldInverse)
          .multiply(item.node.matrixWorld);
        this.characterDrawState.objectToWorld = item.surface.matrixWorld;
        this.characterDrawState.timeSeconds = timeSeconds;
        this.pipeline.prepareCharacterDraw(frame);
        const drawSerial = item.model.drawSerial;
        item.model.draw(
          this.renderMvp,
          frame.framebuffer,
          frame.viewport,
          WHITE_CHARACTER_COLOR,
          this.characterDrawState,
        );
        if (item.model.drawSerial === drawSerial) {
          throw new Error(`Character ${item.target} did not submit its renderer-ready draw`);
        }
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (fence) state.fence = fence;
        else {
          // WebGL2 permits a null fence on allocation failure. A one-time
          // blocking fallback is preferable to falsely declaring readiness.
          gl.finish();
          completed.push(state);
        }
      } catch (error) {
        failed.push({ state, error });
      }
    }
    if (candidates.some((state) => state.fence)) gl.flush();
    this.pipeline.finishCharacterGroup(settings);
    for (const state of completed) this.settleCharacterRenderPrime(state);
    for (const { state, error } of failed) {
      this.settleCharacterRenderPrime(state, error);
    }
  }

  private recordCharacterFrameFailure(
    item: StoryCharacter,
    phase: "update" | "draw",
    error: unknown,
    timeSeconds: number,
  ): void {
    const countKey = phase === "update" ? "updateFailureCount" : "drawFailureCount";
    const retryKey = phase === "update" ? "updateRetryAtSeconds" : "drawRetryAtSeconds";
    const count = item[countKey] + 1;
    item[countKey] = count;
    // Retry transient SDK/GL faults, but cap repeated failures so one broken
    // model cannot consume the whole frame budget or block healthy characters.
    item[retryKey] = timeSeconds + Math.min(4, 0.125 * 2 ** Math.min(5, count - 1));
    if (count === 1 || (count & (count - 1)) === 0) {
      console.error(`[ThreeStoryScene] character ${item.target} ${phase} failed (attempt ${count})`, error);
    }
    if (count >= CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD) {
      this.requestCharacterModelRecovery(item, error, timeSeconds);
    }
  }

  private invokeCharacterModel<T>(
    item: StoryCharacter,
    operation: string,
    fallback: T,
    invoke: (model: ThreeStoryCharacterModel) => T,
  ): T {
    // Logical controller state continues to advance during context restore or
    // a single-flight rebuild. prepareReplacementCharacterModel commits that
    // latest state immediately before installation.
    if (
      this.destroyed ||
      this.contextLost ||
      this.contextRestoreController ||
      this.characterModelRecoveryStates.has(item)
    ) {
      return fallback;
    }
    try {
      return invoke(item.model);
    } catch (error) {
      const failure = new Error(`Character ${item.target} model command ${operation} failed`);
      Object.assign(failure, { cause: error });
      this.requestCharacterModelRecovery(item, failure, this.monotonicSeconds(), true);
      return fallback;
    }
  }

  private async invokeCharacterModelTask<T>(
    item: StoryCharacter,
    operation: string,
    fallback: T,
    invoke: (model: ThreeStoryCharacterModel) => Promise<T>,
  ): Promise<T> {
    if (
      this.destroyed ||
      this.contextLost ||
      this.contextRestoreController ||
      this.characterModelRecoveryStates.has(item)
    ) {
      return fallback;
    }
    try {
      return await invoke(item.model);
    } catch (error) {
      const failure = new Error(`Character ${item.target} model task ${operation} failed`);
      Object.assign(failure, { cause: error });
      this.requestCharacterModelRecovery(item, failure, this.monotonicSeconds(), true);
      return fallback;
    }
  }

  private requestCharacterModelRecovery(
    item: StoryCharacter,
    error: unknown,
    timeSeconds = this.monotonicSeconds(),
    immediate = false,
  ): void {
    if (this.destroyed || this.contextRestoreController || !this.ownsCharacterController(item)) {
      return;
    }
    let state = this.characterModelRecoveryStates.get(item);
    if (!state) {
      if (immediate) {
        console.error(
          `[ThreeStoryScene] character ${item.target} model fault detected; rebuilding independently`,
          error,
        );
      }
      state = {
        generation: 0,
        attempts: 0,
        retryAtSeconds: timeSeconds,
        controller: null,
        detach: null,
      };
      this.characterModelRecoveryStates.set(item, state);
    } else {
      if (immediate) state.retryAtSeconds = Math.min(state.retryAtSeconds, timeSeconds);
    }
    if (
      !this.contextLost &&
      !this.contextRestoreController &&
      !state.controller &&
      state.retryAtSeconds <= timeSeconds
    ) {
      this.startCharacterModelRecovery(item, state);
    }
  }

  private pumpCharacterModelRecoveries(timeSeconds: number): void {
    if (this.destroyed || this.contextLost || this.contextRestoreController) return;
    for (const [item, state] of this.characterModelRecoveryStates) {
      if (!this.ownsCharacterController(item)) {
        this.cancelCharacterModelRecovery(item);
        continue;
      }
      if (!state.controller && state.retryAtSeconds <= timeSeconds) this.startCharacterModelRecovery(item, state);
    }
  }

  private startCharacterModelRecovery(item: StoryCharacter, state: CharacterModelRecoveryState): void {
    if (
      this.destroyed ||
      this.contextLost ||
      this.contextRestoreController ||
      state.controller ||
      this.characterModelRecoveryStates.get(item) !== state ||
      !this.ownsCharacterController(item)
    ) {
      return;
    }
    const controller = new AbortController();
    const detach = this.bindControllerToSignal(controller, this.lifecycleController.signal);
    const generation = ++state.generation;
    const expectedModel = item.model;
    state.controller = controller;
    state.detach = detach;
    state.attempts += 1;
    const attempt = state.attempts;

    void (async () => {
      let replacement: ThreeStoryCharacterModel | null = null;
      try {
        replacement = await this.createCharacterModel(item.target, item.entry, controller.signal);
        if (!replacement) throw new Error(`Unable to rebuild character model ${item.target}`);
        if (!this.isCharacterModelRecoveryCurrent(item, state, generation, expectedModel, controller.signal)) {
          this.disposeCharacterModelSafely(replacement, "stale supervised recovery", item.target);
          return;
        }
        await this.prepareReplacementCharacterModel(item, replacement, controller.signal);
        if (!this.isCharacterModelRecoveryCurrent(item, state, generation, expectedModel, controller.signal)) {
          this.disposeCharacterModelSafely(replacement, "stale supervised recovery preparation", item.target);
          return;
        }

        item.model = replacement;
        item.model.setClockSuspended?.(this.deterministicReplayActive);
        this.placementCache.delete(item);
        replacement = null;
        item.updateFailureCount = 0;
        item.updateRetryAtSeconds = 0;
        item.stalledUpdateCount = 0;
        item.drawFailureCount = 0;
        item.drawRetryAtSeconds = 0;
        item.stalledDrawCount = 0;
        this.characterModelRecoveryStates.delete(item);
        this.disposeCharacterModelSafely(expectedModel, "supervised recovery replacement", item.target);
        this.renderer?.resetState();
        console.info(`[ThreeStoryScene] character ${item.target} model recovered after ${attempt} rebuild attempt(s)`);
      } catch (recoveryError) {
        if (replacement) {
          this.disposeCharacterModelSafely(replacement, "failed supervised recovery", item.target);
        }
        if (!this.isCharacterModelRecoveryCurrent(item, state, generation, expectedModel, controller.signal)) return;
        state.retryAtSeconds =
          this.monotonicSeconds() +
          Math.min(CHARACTER_MODEL_RECOVERY_MAX_DELAY_SECONDS, 0.5 * 2 ** Math.min(6, attempt - 1));
        if (attempt === 1 || (attempt & (attempt - 1)) === 0) {
          console.error(
            `[ThreeStoryScene] character ${item.target} model rebuild failed (attempt ${attempt}); retrying`,
            recoveryError,
          );
        }
      } finally {
        detach();
        if (this.characterModelRecoveryStates.get(item) === state && state.generation === generation) {
          state.controller = null;
          state.detach = null;
        }
      }
    })();
  }

  private isCharacterModelRecoveryCurrent(
    item: StoryCharacter,
    state: CharacterModelRecoveryState,
    generation: number,
    expectedModel: ThreeStoryCharacterModel,
    signal: AbortSignal,
  ): boolean {
    return (
      !this.destroyed &&
      !this.contextLost &&
      !signal.aborted &&
      state.generation === generation &&
      this.characterModelRecoveryStates.get(item) === state &&
      item.model === expectedModel &&
      this.ownsCharacterController(item)
    );
  }

  private cancelCharacterModelRecovery(item: StoryCharacter): void {
    const state = this.characterModelRecoveryStates.get(item);
    if (!state) return;
    this.characterModelRecoveryStates.delete(item);
    state.detach?.();
    state.detach = null;
    state.controller?.abort();
    state.controller = null;
  }

  private cancelAllCharacterModelRecoveries(): void {
    for (const item of [...this.characterModelRecoveryStates.keys()]) this.cancelCharacterModelRecovery(item);
  }

  private characterRenderGroups(characters: readonly StoryCharacter[]): number {
    let groupCount = 0;
    for (const item of characters) {
      if (item.alpha <= 0.0001) continue;
      const blur = Math.max(0, item.blurIntensity);
      const globalTransform = this.screenFilterProvider ? undefined : this.readSceneTransform("stage-main")?.current;
      const transform = this.screenFilterProvider ? undefined : this.readSceneTransform(item.target)?.current;
      const filter = this.screenFilter(item.target);
      const filterTarget = filter?.controller.active ? item.target : undefined;
      const alpha = clamp(item.alpha * (globalTransform?.alpha ?? 1) * (transform?.alpha ?? 1));
      if (alpha <= 0.0001) continue;
      const brightness = Math.max(
        0,
        item.brightness * (globalTransform?.brightness ?? 1) * (transform?.brightness ?? 1),
      );
      const previous = groupCount > 0 ? this.characterRenderGroupPool[groupCount - 1]! : undefined;
      if (
        previous &&
        previous.settings.filterTarget === filterTarget &&
        unityApproximately(previous.settings.blur, blur) &&
        unityApproximately(previous.settings.alpha, alpha) &&
        unityApproximately(previous.settings.brightness, brightness)
      ) {
        previous.items.push(item);
      } else {
        let group = this.characterRenderGroupPool[groupCount];
        if (!group) {
          group = {
            settings: { blur: 0, alpha: 1, brightness: 1, radiusMax: 0 },
            items: [],
          };
          this.characterRenderGroupPool.push(group);
        }
        group.settings.blur = blur;
        group.settings.filterTarget = filterTarget;
        group.settings.filter = filterTarget ? filter!.render : undefined;
        group.settings.alpha = alpha;
        group.settings.brightness = brightness;
        group.settings.radiusMax = Math.max(0, this.fieldRendererState.blurRadiusMax);
        group.items.length = 0;
        group.items.push(item);
        groupCount += 1;
      }
    }
    for (let index = groupCount; index < this.characterRenderGroupPool.length; index += 1) {
      this.characterRenderGroupPool[index]!.items.length = 0;
    }
    return groupCount;
  }

  private effectLayer(scene: Scene): AdvSceneLayer | null {
    if (!scene.children.length) return null;
    let layer = this.sceneLayerCache.get(scene);
    if (!layer) {
      layer = { scene, camera: this.camera };
      this.sceneLayerCache.set(scene, layer);
    }
    return layer;
  }

  private commandCharacterScene(positionType: number): Scene {
    let scene = this.commandCharacterScenes.get(positionType);
    if (!scene) {
      scene = new Scene();
      scene.name = `Unity ADV Camera${(positionType + 1) / 2} Command Effects`;
      this.commandCharacterScenes.set(positionType, scene);
    }
    return scene;
  }

  private commandEffectScene(route: AdvEffectRoute): Scene {
    if (route.phase === "advBack") return this.commandAdvBackScene;
    if (route.phase === "ui") return this.commandUiScene;
    if (route.phase === "character") return this.commandCharacterScene(route.positionType ?? 5);
    return this.commandAdvFrontScene;
  }

  private harmonicBlends(
    item: StoryCharacter,
    parameterSource: ThreeStoryCharacterModel = item.model,
  ): ThreeCharacterParameterBlend[] {
    if (!this.qualityConfig.isCharacterBreathMotionEnabled()) {
      item.harmonicBlends.length = 0;
      return item.harmonicBlends;
    }
    const harmonic = item.entry.harmonicMotion || record(item.entry.runtime).harmonicMotion;
    return evaluateAdvHarmonicMotion(
      harmonic as AdvHarmonicMotionData | null | undefined,
      item.harmonicTime,
      parameterSource,
      item.harmonicBlends,
    );
  }

  private updateLipSync(item: StoryCharacter, deltaSeconds: number): void {
    const lip = item.lipSync;
    if (!lip.enabled) return;
    const pseudoPlaybackRate = lip.source === "timed" ? this.playbackSpeedRate : 1;
    if (lip.source === "voice") {
      if (!lip.sources.length && item.model.motionSyncStatus === "unconfigured") {
        // Native leaves Timed in LipMode 2 for one OnLateUpdate when no
        // MotionSync controller exists; that frame runs ResetLip.
        this.resetLipSync(item);
        return;
      }
      lip.voiceRemaining = Math.max(
        0,
        (lip.voiceExpiresAtSeconds - this.monotonicSeconds()) * Math.max(0.001, lip.voiceSpeed),
      );
      const motionSyncReady = item.model.motionSyncStatus === "ready";
      const input = sampleVoiceMotionSyncInput(lip.sources, motionSyncReady, item.voiceMotionSyncInput);
      lip.motionSyncPcm = motionSyncReady ? input.pcm : null;
      if (lip.motionSyncPcm) {
        // Core output controls both ParamMouthOpenY and ParamMouthForm. These
        // fallback fields must not be blended over the captured-base result.
        lip.mouthOpenY = 0;
        lip.mouthForm = 0;
      } else if (input.playing && !input.analyzable) {
        // Old WebViews and a Howler backend fallback may expose no decoded PCM
        // or analyser. Keep that rare path speech-like and aperiodic rather
        // than returning to a fixed 0.4 s triangle wave.
        const pseudo = advanceAdvPseudoLipSync(lip, {
          deltaSeconds,
          currentMouthOpening: lip.mouthOpenY,
          multiplier: lip.voiceMultiplier,
          random: () => nextRandom(lip.randomSeed),
        });
        lip.mouthOpenY = clamp(pseudo.rawOpening);
      } else {
        const target = input.playing ? voiceRmsMouthOpening(input.rms, lip.voiceMultiplier) : 0;
        lip.mouthOpenY +=
          (target - lip.mouthOpenY) * (1 - Math.exp(-deltaSeconds / (target > lip.mouthOpenY ? 0.025 : 0.075)));
      }
      if (!input.playing && !input.pending && lip.voiceRemaining <= 0 && lip.mouthOpenY < 0.001) {
        this.resetLipSync(item);
      }
      return;
    }

    this.advanceTimedLipSyncFrame(item, deltaSeconds, pseudoPlaybackRate);
  }

  private advanceTimedLipSyncFrame(item: StoryCharacter, deltaSeconds: number, playbackRate: number): void {
    const lip = item.lipSync;
    if (!lip.enabled || lip.source !== "timed") return;
    const rate = Math.max(0.001, finite(playbackRate, 1));
    const scaledDelta = Math.max(0, deltaSeconds) * Math.max(0.001, lip.speed) * rate;
    lip.motionSyncPcm = null;
    // OnLateUpdate updates the oscillator before decrementing the talk timer.
    // The frame that crosses zero only arms the 0.3 s close tail; subtraction
    // from that tail begins on the following frame.
    const stopping = lip.timedRemaining < 0;
    const pseudo =
      lip.timedMode === "hold-open"
        ? advanceAdvHoldOpenPseudoLipSync(lip, {
            deltaSeconds,
            speedMultiplier: rate,
            currentMouthOpening: lip.mouthOpenY,
            manualLevel: lip.holdOpenLevel,
            stopping,
            random: () => nextRandom(lip.randomSeed),
          })
        : advanceAdvPseudoLipSync(lip, {
            deltaSeconds,
            speedMultiplier: rate,
            currentMouthOpening: lip.mouthOpenY,
            multiplier: lip.multiplier,
            stopping,
            random: () => nextRandom(lip.randomSeed),
          });
    lip.mouthOpenY = clamp(pseudo.rawOpening);

    if (!stopping) {
      lip.timedRemaining -= scaledDelta;
      if (lip.timedRemaining <= 0) lip.stopRemaining = PSEUDO_LIP_STOP_DURATION;
    } else if (lip.stopRemaining >= 0) {
      lip.stopRemaining -= scaledDelta;
      if (lip.stopRemaining <= 0) this.finishTimedLipSync(item);
    }
  }

  private resetLipSync(item: StoryCharacter): void {
    Object.assign(item.lipSync, {
      enabled: false,
      source: "none",
      timedMode: "oscillating",
      holdOpenLevel: 0,
      timedRemaining: 0,
      voiceRemaining: 0,
      voiceSpeed: 1,
      voiceMultiplier: 1,
      voiceExpiresAtSeconds: 0,
      stopRemaining: 0,
      speed: 1,
      timer: 0,
      openScale: 0,
      isOpen: false,
      beforeLevel: 0,
      mouthOpenY: 0,
      mouthForm: 0,
      motionSyncPcm: null,
      dampVelocity: { value: 0 },
      sources: [],
    });
    this.invokeCharacterModel(item, "reset motion sync", undefined, (model) => model.resetMotionSync());
  }

  private finishTimedLipSync(item: StoryCharacter): void {
    this.leaveTimedLipSync(item);
  }

  private fieldPosition(kind: "background" | "character", target: Vec3): Vec3 {
    const stage = record(this.state.stage || this.runtime.stage);
    const key = kind === "background" ? "backgroundFieldPosition" : "characterFieldPosition";
    const fallback = kind === "background" ? BACKGROUND_FIELD_POSITION : CHARACTER_FIELD_POSITION;
    return vec3(stage[key] ?? record(this.runtime.stage)[key], fallback, target);
  }

  private fieldScale(kind: "background" | "character"): number {
    const stage = record(this.state.stage || this.runtime.stage);
    const key = kind === "background" ? "backgroundFieldScale" : "characterFieldScale";
    return Math.max(0.001, finite(stage[key] ?? record(this.runtime.stage)[key], kind === "background" ? 1 : 4));
  }

  private stageFov(): number {
    return Math.max(1, finite(record(this.state.stage).fov, finite(this.runtime.stage.fov, 39.6)));
  }

  private applyTransforms(): void {
    const backgroundPosition = this.fieldPosition("background", this.scratchBackgroundPosition);
    backgroundPosition.x += this.backgroundShake.x;
    backgroundPosition.y += this.backgroundShake.y;
    unityVector3(backgroundPosition, this.backgroundField.position);
    this.backgroundCaptureField.position.copy(this.backgroundField.position);
    const characterPosition = this.fieldPosition("character", this.scratchCharacterPosition);
    characterPosition.x += this.characterShake.x;
    characterPosition.y += this.characterShake.y;
    unityVector3(characterPosition, this.characterField.position);
    // ApplyFieldScale obtains the SpriteRenderer transform from its parent
    // field. The shared _field root remains unscaled; in particular, the
    // fixed black BaseRenderer and its local Z offset never inherit this value.
    this.backgroundField.scale.setScalar(1);
    this.backgroundCaptureField.scale.copy(this.backgroundField.scale);
    const tint = stageSpriteTint(record(this.state.stage).backgroundColor, this.scratchTint);
    const backgroundBrightness = Math.max(0, this.fieldRendererState.brightness);
    this.applyBackgroundTint(this.backgroundMesh, tint, backgroundBrightness);
    this.applyBackgroundTint(this.backgroundCaptureMesh, tint, backgroundBrightness);
    this.scratchEuler.x = 0;
    this.scratchEuler.y = this.cameraState.fieldRotationY;
    this.scratchEuler.z = 0;
    unityEulerDegrees(this.scratchEuler, this.backgroundField.quaternion);
    this.backgroundCaptureField.quaternion.copy(this.backgroundField.quaternion);
    unityEulerDegrees(this.scratchEuler, this.characterField.quaternion);
    const cameraPosition = this.scratchStagePosition;
    cameraPosition.x = this.cameraState.baseX + this.cameraState.panOffsetX + this.cameraShake.x;
    cameraPosition.y = this.cameraState.baseY + this.cameraShake.y;
    cameraPosition.z = this.cameraState.baseZ + this.cameraState.panOffsetY;
    unityVector3(cameraPosition, this.camera.position);
    this.scratchEuler.x = this.cameraState.rotationX;
    this.scratchEuler.y = this.cameraState.rotationY;
    this.scratchEuler.z = this.cameraState.angle;
    unityEulerDegrees(this.scratchEuler, this.camera.quaternion);
    const fov = AdvCamera.effectiveFov(this.stageFov(), this.cameraState.zoomRatio);
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const globalTransform = this.readSceneTransform("stage-main")?.current;
    this.scene.matrixAutoUpdate = this.backgroundCaptureScene.matrixAutoUpdate = false;
    if (globalTransform)
      sceneTransformMatrix(
        globalTransform,
        this.coordinateReference(),
        this.coordinateDepth("stage-main"),
        this.scene.matrix,
      );
    else this.scene.matrix.identity();
    this.scene.matrixWorldNeedsUpdate = true;
    this.backgroundCaptureScene.matrix.copy(this.scene.matrix);
    this.backgroundCaptureScene.matrixWorldNeedsUpdate = true;
    this.characterField.updateMatrix();
    const backgroundTransform = this.readSceneTransform("bg-main")?.current;
    for (const field of [this.backgroundField, this.backgroundCaptureField]) {
      field.updateMatrix();
      field.matrixAutoUpdate = false;
      if (backgroundTransform)
        field.matrix.premultiply(
          sceneTransformMatrix(
            backgroundTransform,
            this.coordinateReference(),
            this.coordinateDepth("bg-main"),
            this.sceneTargetMatrix,
          ),
        );
    }
    const characterFieldScale = this.fieldScale("character");
    this.refreshStageNodes(characterFieldScale);
    for (const item of this.characterItems.values()) this.layoutCharacter(item, characterFieldScale);
  }

  private applyBackgroundTint(mesh: BackgroundMesh | null, tint: MutableColor4, brightness: number): void {
    if (!mesh) return;
    // AdvBackgroundField.ApplyBrightness multiplies only the stored
    // SpriteRenderer RGB by brightness and preserves tint alpha.
    const globalTransform = this.screenFilterProvider ? undefined : this.readSceneTransform("stage-main")?.current;
    const transform = this.screenFilterProvider ? undefined : this.readSceneTransform("bg-main")?.current;
    const value = brightness * (globalTransform?.brightness ?? 1) * (transform?.brightness ?? 1);
    mesh.material.color.setRGB(tint.r * value, tint.g * value, tint.b * value);
    mesh.material.opacity = tint.a * (globalTransform?.alpha ?? 1) * (transform?.alpha ?? 1);
  }

  stagePoint(positionType: unknown): Vec3 {
    const key = Number(positionType) || 5;
    return this.stagePointInto(key, { x: 0, y: 0, z: 0 });
  }

  private stagePointInto(key: number, target: Vec3): Vec3 {
    return vec3(this.runtime.stage.positions?.[key] || this.runtime.stage.focusAnchors?.[key], ZERO_VEC3, target);
  }

  private focusPointInternal(positionType: unknown): Vec3 {
    const key = Number(positionType) || 5;
    return vec3(this.runtime.stage.focusAnchors?.[key] || this.runtime.stage.positions?.[key], ZERO_VEC3);
  }

  private stageOffsetInternal(positionType: number): Vec3 {
    const key = Number(positionType) || 0;
    this.stageNodeKeys.add(key);
    let value = this.stageOffsets.get(key);
    if (!value) {
      value = { x: 0, y: 0, z: 0 };
      this.stageOffsets.set(key, value);
    }
    return value;
  }

  private stageNode(positionType: number): Object3D {
    const key = Number(positionType) || 5;
    this.stageNodeKeys.add(key);
    let node = this.stageNodes.get(key);
    if (!node) {
      node = new Object3D();
      node.name = `AdvCharacterStage${key}`;
      this.stageNodes.set(key, node);
      this.characterField.add(node);
    }
    return node;
  }

  private refreshStageNodes(fieldScale = this.fieldScale("character")): void {
    this.scratchEuler.x = 0;
    this.scratchEuler.y = this.cameraState.stageRotationY;
    this.scratchEuler.z = 0;
    for (const key of this.stageNodeKeys) {
      const node = this.stageNode(key);
      const base = this.stagePointInto(key, this.scratchStagePosition);
      const offset = this.stageOffsetInternal(key);
      base.x += offset.x;
      base.y += offset.y;
      base.z += offset.z;
      unityVector3(base, node.position);
      unityEulerDegrees(this.scratchEuler, node.quaternion);
      // AdvCharacterField.ApplyFieldScale scales each of the five stage
      // transforms, not the character-field root.
      node.scale.setScalar(fieldScale);
    }
  }

  private layoutCharacter(item: StoryCharacter, fieldScale = this.fieldScale("character")): void {
    const profile = item.entry.profile || {};
    const placement = this.characterPlacement(item);
    const basePosition = vec3(profile.basePosition, CHARACTER_BASE_POSITION, this.scratchCharacterBasePosition);
    const scale = placement ? placement.scale : Math.max(0.001, finite(profile.baseScale, 1.6));
    const authoredPosition = item.worldPosition ?? placement?.position;
    const expectedParent = this.stageNode(item.positionType);
    if (item.node.parent !== expectedParent) expectedParent.add(item.node);
    if (authoredPosition) {
      // Absolute adapter coordinates are resolved into the same authored ADV
      // field basis as native stage points. Dynamic field/stage transforms stay
      // on the parent nodes, so shake, tilt and camera movement affect both
      // placement modes through the regular scene graph.
      const fieldPosition = this.fieldPosition("character", this.scratchCharacterPosition);
      const stagePosition = this.stagePointInto(item.positionType, this.scratchStagePosition);
      basePosition.x = (authoredPosition.x + item.offset.x - fieldPosition.x - stagePosition.x) / fieldScale;
      basePosition.y = (authoredPosition.y + item.offset.y - fieldPosition.y - stagePosition.y) / fieldScale;
      basePosition.z = (authoredPosition.z + item.offset.z - fieldPosition.z - stagePosition.z) / fieldScale;
    } else {
      basePosition.x += item.offset.x / fieldScale;
      basePosition.y += item.offset.y / fieldScale;
      basePosition.z += item.offset.z / fieldScale;
    }
    unityVector3(basePosition, item.node.position);
    item.node.scale.set(scale * item.facing, scale, scale);
    this.scratchEuler.x = 0;
    this.scratchEuler.y = 0;
    this.scratchEuler.z = item.roleAngle;
    unityEulerDegrees(this.scratchEuler, item.node.quaternion);
    if (placement) {
      unityEulerDegrees(this.coordinateReference().rotation ?? ZERO_VEC3, this.sceneReferenceRotation);
      item.node.quaternion.premultiply(this.sceneReferenceRotation);
    }
    item.node.matrixAutoUpdate = false;
    item.node.updateMatrix();
    const transform = this.readSceneTransform(item.target)?.current;
    if (transform) {
      expectedParent.updateMatrix();
      this.characterField.updateMatrix();
      this.sceneParentMatrix.multiplyMatrices(this.characterField.matrix, expectedParent.matrix);
      this.sceneParentInverse.copy(this.sceneParentMatrix).invert();
      this.scenePivot.copy(item.node.position).applyMatrix4(this.sceneParentMatrix);
      sceneTransformMatrix(
        transform,
        this.coordinateReference(),
        this.coordinateDepth(item.target),
        this.sceneTargetMatrix,
        this.scenePivot,
      );
      item.node.matrix
        .premultiply(this.sceneParentMatrix)
        .premultiply(this.sceneTargetMatrix)
        .premultiply(this.sceneParentInverse);
    }
    item.node.matrixWorldNeedsUpdate = true;
    item.surface.position.set(-(placement?.origin.x ?? 0), -(placement?.origin.y ?? 0), 0);
    item.surface.updateMatrix();
  }

  private spritePlaneProjection(layer: "background" | "foreground"): Matrix4 {
    const reference = this.coordinateReference(),
      depth = this.coordinateDepth(layer === "background" ? "bg-main" : "stage-main");
    const size = scenePlaneSize(reference, depth);
    unityEulerDegrees(reference.rotation ?? ZERO_VEC3, this.sceneReferenceRotation);
    unityVector3(reference.position, this.scenePivot);
    this.spritePlaneMatrix.compose(this.scenePivot, this.sceneReferenceRotation, this.renderWorldPosition.set(1, 1, 1));
    const aspect = finite(record(this.runtime.layout).designViewportAspect, this.camera.aspect);
    this.sceneTargetMatrix.makeScale((size.height * aspect) / 2, size.height / 2, 1).setPosition(0, 0, -depth);
    this.spritePlaneMatrix.multiply(this.sceneTargetMatrix);
    return this.spriteProjection
      .copy(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse)
      .multiply(this.scene.matrixWorld)
      .multiply(this.spritePlaneMatrix);
  }

  private characterProjection(item: StoryCharacter, matrix: Matrix4): void {
    matrix
      .copy(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse)
      .multiply(item.surface.matrixWorld);
  }

  private characterCanvasBounds(item: StoryCharacter): { x: number; y: number; width: number; height: number } {
    const bounds = item.model.canvasBounds(),
      base = record(record(item.entry.profile).placement);
    const layout = { ...base, ...record(record(base.positions)[String(item.positionType)]) };
    const padding = Array.isArray(layout.padding) ? layout.padding : [];
    if (!padding.length) return bounds;
    const unit = Math.max(0.000001, item.model.pixelsPerUnit);
    const top = finite(padding[0]) / unit,
      right = finite(padding[1]) / unit,
      bottom = finite(padding[2]) / unit,
      left = finite(padding[3]) / unit;
    return {
      x: bounds.x - left,
      y: bounds.y - bottom,
      width: Math.max(0.000001, bounds.width + left + right),
      height: Math.max(0.000001, bounds.height + top + bottom),
    };
  }

  private characterPlacement(item: StoryCharacter): { position: Vec3; origin: Vec3; scale: number } | undefined {
    const base = record(item.entry.profile).placement;
    if (!base || typeof base !== "object") return undefined;
    let cache = this.placementCache.get(item);
    if (!cache || cache.stage !== this.runtime.stage) {
      cache = { stage: this.runtime.stage, positions: new Map() };
      this.placementCache.set(item, cache);
    }
    let placement = cache.positions.get(item.positionType);
    if (!placement) {
      const layout = { ...record(base), ...record(record(record(base).positions)[String(item.positionType)]) };
      const bounds = this.characterCanvasBounds(item);
      const fit = resolveStoryPlaneLayout(layout as StoryPlaneLayout, bounds.width, bounds.height);
      const reference = { ...this.coordinateReference(), width: fit.referenceWidth, height: fit.referenceHeight };
      const depth = this.coordinateDepth(item.target),
        unit = scenePlaneSize(reference, depth).height / reference.height;
      const scale = fit.scale * unit,
        center = { ...scenePointFromPixels(reference, fit.x, fit.y, depth) };
      if (record(layout).anchor === "stage") {
        const slot = this.stagePoint(item.positionType);
        center.x += slot.x;
        center.y += slot.y;
        center.z += slot.z;
      }
      placement = {
        position: center,
        origin: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, z: 0 },
        scale: scale / Math.max(0.001, finite(this.runtime.stage.characterFieldScale, 4)),
      };
      cache.positions.set(item.positionType, placement);
    }
    return placement;
  }

  private characterAuthoredWorldPosition(item: StoryCharacter): Vec3 {
    const position = item.worldPosition ?? this.characterPlacement(item)?.position;
    if (position) return { ...position };
    const profile = item.entry.profile || {};
    const base = vec3(profile.basePosition, CHARACTER_BASE_POSITION);
    const field = this.fieldPosition("character", { x: 0, y: 0, z: 0 });
    const stage = this.stagePoint(item.positionType);
    const fieldScale = this.fieldScale("character");
    return {
      x: field.x + stage.x + base.x * fieldScale + item.offset.x,
      y: field.y + stage.y + base.y * fieldScale + item.offset.y,
      z: field.z + stage.z + base.z * fieldScale + item.offset.z,
    };
  }

  private beginCharacterLoad(target: string, cmd: AdvCommand): { scene: number; target: number; signal: AbortSignal } {
    this.cancelCharacterOwnedTweens(target);
    this.cancelPendingAngleWait(target);
    this.cancelPendingLookWait(target);
    this.cancelPendingCharacterLoadController(target);
    this.releaseStagedCharacter(target);
    this.pendingCharacterPlacements.delete(target);
    this.pendingCharacterWorldPositions.delete(target);
    const targetToken = ++this.characterLoadSequence;
    this.characterLoadTokens.set(target, targetToken);
    const entry = cmd.characterModel as StoryCharacterEntry | undefined;
    this.pendingCharacterCommands.begin(
      target,
      targetToken,
      firstString(entry?.profile?.defaultExpressionName, record(entry?.runtime).defaultExpressionName),
    );
    this.characterPresentationHistory.set(target, []);
    const controller = new AbortController();
    const detach = this.bindControllerToSignal(controller, this.lifecycleController.signal);
    this.pendingCharacterLoadControllers.set(target, { token: targetToken, controller, detach });
    return { scene: this.sceneGeneration, target: targetToken, signal: controller.signal };
  }

  private invalidateCharacterLoad(target: string): void {
    this.cancelPendingAngleWait(target);
    this.cancelPendingLookWait(target);
    this.releaseStagedCharacter(target);
    this.pendingCharacterPlacements.delete(target);
    this.pendingCharacterWorldPositions.delete(target);
    this.pendingCharacterCommands.invalidate(target);
    this.cancelPendingCharacterLoadController(target);
    this.characterLoadTokens.set(target, ++this.characterLoadSequence);
  }

  private cancelPendingCharacterLoadController(target: string, token?: number): void {
    const pending = this.pendingCharacterLoadControllers.get(target);
    if (!pending || (token != null && pending.token !== token)) return;
    this.pendingCharacterLoadControllers.delete(target);
    pending.detach();
    pending.controller.abort();
  }

  private completePendingCharacterLoadController(target: string, token: number): void {
    const pending = this.pendingCharacterLoadControllers.get(target);
    if (!pending || pending.token !== token) return;
    this.pendingCharacterLoadControllers.delete(target);
    pending.detach();
  }

  private releaseStagedCharacter(target: string, expected?: StoryCharacter): void {
    const staged = this.stagedCharacterItems.get(target);
    if (!staged || (expected && staged.item !== expected)) return;
    this.stagedCharacterItems.delete(target);
    this.cancelCharacterModelRecovery(staged.item);
    staged.item.angleTweenController?.abort();
    staged.item.lookTweenController?.abort();
    staged.item.node.removeFromParent();
    this.releaseCharacterModelSafely(staged.item, "staged character release");
  }

  private stageCharacter(target: string, token: number, item: StoryCharacter): boolean {
    if (token !== this.characterLoadTokens.get(target)) return false;
    this.releaseStagedCharacter(target);
    this.stagedCharacterItems.set(target, { token, item });
    return true;
  }

  private commitStagedCharacter(target: string, token: number, item: StoryCharacter): boolean {
    const staged = this.stagedCharacterItems.get(target);
    if (!staged || staged.token !== token || staged.item !== item) return false;
    this.stagedCharacterItems.delete(target);
    const identity = this.pendingCharacterPlacements.get(target)?.identity;
    this.pendingCharacterPlacements.delete(target);
    this.registerVisibleCharacter(target, item);
    const resolvedIdentity =
      identity || firstString(item.characterKey, item.entry.url, record(item.entry.runtime).modelUrl, target);
    // CharacterIn captures the controller it started with, but a Costume can
    // change the loader's selected TargetName+AssetIndex while this browser
    // model is still loading. Preserve that newer selection just as the
    // native loader's asset-index map does.
    const selectedIdentity = this.characterControllerIdentities.get(target);
    if (!selectedIdentity || selectedIdentity === resolvedIdentity) {
      this.characterControllerIdentities.set(target, resolvedIdentity);
    }
    const existing = this.cachedCharacterControllers.get(resolvedIdentity);
    if (existing && existing !== item && this.speculativeCharacterControllers.get(resolvedIdentity) === existing) {
      // Episode warmup may have started just after CharacterIn checked the
      // single-flight map. The command-owned controller has already consumed
      // the live pending presentation, so it wins; dispose the never-visible
      // speculative duplicate before replacing the cache entry.
      this.speculativeCharacterControllers.delete(resolvedIdentity);
      this.speculativeCharacterCommandIndices.delete(resolvedIdentity);
      this.cachedCharacterControllers.delete(resolvedIdentity);
      this.releaseUnownedPreloadedCharacter(existing, "speculative character superseded by CharacterIn");
    }
    this.cachedCharacterControllers.set(resolvedIdentity, item);
    this.completePendingCharacterLoadController(target, token);
    return true;
  }

  /**
   * Keep the currently visible controller alive until its replacement is
   * renderer-ready. Replacing the map entry is the actual visibility switch;
   * cached controllers remain owned by their TargetName+AssetIndex identity.
   */
  private registerVisibleCharacter(target: string, item: StoryCharacter): void {
    const previous = this.characterItems.get(target);
    if (previous && previous !== item) {
      previous.model.setClockSuspended?.(true);
      this.characterFadeCoordinator.cancel(previous.positionType);
      this.characterItems.delete(target);
    }
    item.model.setClockSuspended?.(this.deterministicReplayActive);
    registerCharacterItem(this.characterItems, target, item, () => this.layoutCharacter(item));
  }

  private cachedCharacterController(target: string): StoryCharacter | null {
    const identity = this.characterControllerIdentities.get(target);
    return this.cachedCharacterControllerByIdentity(identity);
  }

  private cachedCharacterControllerByIdentity(identity: string | undefined): StoryCharacter | null {
    if (!identity) return null;
    const item = this.cachedCharacterControllers.get(identity) || null;
    // The first authored command that addresses a prepared controller makes
    // it live. Stop counting it as speculative immediately so a concurrent
    // CharacterIn cannot race pool bookkeeping.
    if (item) {
      this.speculativeCharacterControllers.delete(identity);
      this.speculativeCharacterCommandIndices.delete(identity);
      this.notifyCharacterPreloadCapacity();
    }
    return item;
  }

  private discardSpeculativeCharacter(identity: string, item: StoryCharacter, reason: string): void {
    if (this.speculativeCharacterControllers.get(identity) !== item) return;
    this.speculativeCharacterControllers.delete(identity);
    this.speculativeCharacterCommandIndices.delete(identity);
    if (this.cachedCharacterControllers.get(identity) === item) {
      this.cachedCharacterControllers.delete(identity);
    }
    this.discardedCharacterPreloadIdentities.add(identity);
    this.notifyCharacterPreloadCapacity();
    this.cancelCharacterModelRecovery(item);
    item.angleTweenController?.abort();
    item.lookTweenController?.abort();
    item.node.removeFromParent();
    void this.releaseCharacterModelSafely(item, reason);
  }

  private releaseUnownedPreloadedCharacter(item: StoryCharacter, reason: string): void {
    this.cancelCharacterModelRecovery(item);
    item.angleTweenController?.abort();
    item.lookTweenController?.abort();
    item.node.removeFromParent();
    void this.releaseCharacterModelSafely(item, reason);
  }

  /**
   * Release cached controllers that are neither on stage, staged for entry,
   * pending a placement, in recovery, nor the currently selected variant of
   * their target — typically superseded costume variants after a Costume
   * switch. Reported as discarded so Vega rebuilds them if a later command
   * addresses them again.
   */
  /**
   * Dispose textures that only an evicted/removed model references. Character
   * atlases dominate VRAM; without this, costume swaps accumulated every
   * variant's texture pages for the whole episode.
   */
  private evictIdleResidentControllers(keepIdentity: string): void {
    for (const [identity, item] of [...this.cachedCharacterControllers]) {
      if (identity === keepIdentity) continue;
      if (this.characterItems.get(item.target) === item) continue;
      if (this.characterControllerIdentities.get(item.target) === identity) continue;
      if (this.stagedCharacterItems.get(item.target)?.item === item) continue;
      let placed = false;
      for (const pending of this.pendingCharacterPlacements.values()) {
        if (pending.identity === identity) {
          placed = true;
          break;
        }
      }
      if (placed) continue;
      if (this.characterModelRecoveryStates.has(item)) continue;
      this.cachedCharacterControllers.delete(identity);
      this.speculativeCharacterControllers.delete(identity);
      this.speculativeCharacterCommandIndices.delete(identity);
      this.discardedCharacterPreloadIdentities.add(identity);
      this.releaseUnownedPreloadedCharacter(item, "character cache pressure");
    }
    this.notifyCharacterPreloadCapacity();
  }

  private discardAllSpeculativeCharacters(reason: string): void {
    // In-flight builders already observe context generation and retry after
    // restoration. Keep their promise alive so a blocking initial warmup does
    // not turn a transient WebGL loss into a story-load failure.
    for (const [identity, item] of [...this.speculativeCharacterControllers]) {
      this.discardSpeculativeCharacter(identity, item, reason);
    }
  }

  private ownsCharacterController(item: StoryCharacter): boolean {
    if (this.characterItems.get(item.target) === item) return true;
    for (const cached of this.cachedCharacterControllers.values()) {
      if (cached === item) return true;
    }
    for (const staged of this.stagedCharacterItems.values()) {
      if (staged.item === item) return true;
    }
    return false;
  }

  private selectedPendingCharacterToken(target: string): number | null {
    const pending = this.pendingCharacterPlacements.get(target);
    const identity = this.characterControllerIdentities.get(target);
    if (
      !pending ||
      !identity ||
      pending.identity !== identity ||
      this.characterLoadTokens.get(target) !== pending.token
    ) {
      return null;
    }
    return pending.token;
  }

  private async markPendingCharacterFadeInStarted(target: string, placement: PendingCharacterPlacement): Promise<void> {
    if (placement.fadeInDurationSeconds <= 0) return;
    for (let frame = 0; frame < UNITY_CHARACTER_FADE_DELAY_FRAMES; frame += 1) await nextFrame();
    if (
      this.pendingCharacterPlacements.get(target) === placement &&
      this.characterLoadTokens.get(target) === placement.token
    ) {
      placement.fadeInStartedAtSeconds = this.monotonicSeconds();
    }
  }

  private pendingCharacterFadeInAlpha(target: string, token: number, atSeconds: number): number {
    const placement = this.pendingCharacterPlacements.get(target);
    if (!placement || placement.token !== token) return 1;
    const duration = Math.max(0, placement.fadeInDurationSeconds);
    if (duration <= 0) return 1;
    if (placement.fadeInStartedAtSeconds == null) return 0;
    return clamp((atSeconds - placement.fadeInStartedAtSeconds) / duration);
  }

  /** Mirror AdvEpisodeResourceLoader.SetCharacterAssetIndex for controller lookup. */
  selectCharacterAssetIndex(target: string, assetIndex: number): void {
    const name = String(target || "");
    if (!name) return;
    this.characterControllerIdentities.set(name, `${name}\u0000${Number(assetIndex) || 0}`);
  }

  private cancelPendingLookWait(target: string): void {
    const controller = this.pendingLookWaitControllers.get(target);
    if (!controller) return;
    this.pendingLookWaitControllers.delete(target);
    controller.abort();
  }

  private cancelPendingAngleWait(target: string): void {
    const controller = this.pendingAngleWaitControllers.get(target);
    if (!controller) return;
    this.pendingAngleWaitControllers.delete(target);
    controller.abort();
  }

  private resetCharacterAngleLook(item: StoryCharacter): void {
    this.cancelPendingAngleWait(item.target);
    this.cancelPendingLookWait(item.target);
    item.angleTweenController?.abort();
    item.lookTweenController?.abort();
    item.angleTweenController = null;
    item.lookTweenController = null;
    item.angle = 0;
    item.bodyAngle = 0;
    item.angleOverride = false;
    item.lookX = 0;
    item.lookY = 0;
    item.lookOriginalX = 0;
    item.lookOriginalY = 0;
    item.lookOverride = false;
  }

  private recordCharacterPresentation(target: string, event: AdvCharacterPresentationEvent): void {
    const history = this.characterPresentationHistory.get(target) || [];
    history.push(event);
    this.characterPresentationHistory.set(target, history);
  }

  private hasCharacterPresentationResource(
    entry: StoryCharacterEntry | undefined,
    channel: "motions" | "expressions",
    name: string,
  ): boolean {
    if (!entry || !name) return false;
    const resources = entry[channel];
    // Some embedders provide only model3.json and let character plugin expose its own
    // resource index. A populated prepared catalogue, however, is the exact
    // equivalent of a provider's motion/expression resource maps and can
    // reject an authored typo synchronously before it overwrites pending Show
    // state.
    if (!Array.isArray(resources) || resources.length === 0) return true;
    return resources.some((resource) => String(record(resource).name || "") === name);
  }

  private isCharacterLoadCurrent(
    target: string,
    token: { scene: number; target: number; signal: AbortSignal },
  ): boolean {
    return (
      !this.destroyed &&
      !token.signal.aborted &&
      token.scene === this.sceneGeneration &&
      token.target === this.characterLoadTokens.get(target) &&
      Boolean(this.renderer)
    );
  }

  private normalizeCharacterModelEntry(entry: StoryCharacterEntry): StoryCharacterEntry {
    const source = record(entry);
    const runtime = record(source.runtime);
    const normalizedRuntime: Record<string, unknown> = { ...runtime };
    const aliases = {
      model: firstString(runtime.model, runtime.modelUrl, source.model, source.modelUrl),
      moc: firstString(runtime.moc, source.moc),
      physics: firstString(runtime.physics, source.physics),
      imageUrl: firstString(runtime.imageUrl, source.imageUrl),
      skeleton: firstString(runtime.skeleton, source.skeleton),
      skel: firstString(runtime.skel, source.skel),
      json: firstString(runtime.json, source.json),
      atlas: firstString(runtime.atlas, source.atlas),
      format: firstString(runtime.format, source.format),
    };
    for (const [field, value] of Object.entries(aliases)) {
      if (value) normalizedRuntime[field] = value;
    }
    const textures = Array.isArray(runtime.textures)
      ? runtime.textures
      : Array.isArray(source.textures)
        ? source.textures
        : undefined;
    if (textures) normalizedRuntime.textures = [...textures];
    return {
      ...entry,
      runtime: normalizedRuntime,
    } as StoryCharacterEntry;
  }

  private async createCharacterModel(
    target: string,
    entry: StoryCharacterEntry,
    signal?: AbortSignal,
    ancestry: readonly string[] = [],
  ): Promise<ThreeStoryCharacterModel | null> {
    const normalizedEntry = this.normalizeCharacterModelEntry(entry);
    const source = firstString(
      normalizedEntry.runtime?.model,
      normalizedEntry.runtime?.imageUrl,
      normalizedEntry.runtime?.modelUrl,
    );
    const identity = `${firstString(normalizedEntry.runtime?.format)}:${source}`;
    if (ancestry.length >= 32 || (source && ancestry.includes(identity)))
      throw new TypeError("Cyclic or excessively nested character model");
    const provider = this.characterProviders.find((candidate) => {
      if (!candidate.supports(normalizedEntry) || !isRendererAwareCharacterProvider(candidate)) {
        return false;
      }
      const rendererAware = candidate as ThreeRendererAwareCharacterProvider;
      return typeof rendererAware.supportsRenderer !== "function" || rendererAware.supportsRenderer(this.rendererId);
    }) as ThreeRendererAwareCharacterProvider | undefined;
    if (provider) {
      const renderer = this.renderer;
      if (!renderer) return null;
      const gl = renderer.getContext();
      if (!(gl instanceof WebGL2RenderingContext)) {
        throw new Error("Three character rendering requires WebGL2");
      }
      const providerSignal = signal ?? this.lifecycleController.signal;
      const providerContext: ThreeCharacterProviderContext = {
        renderer: this.rendererId,
        rendererContext: this.createRendererContext(renderer, gl),
        target,
        entry: normalizedEntry,
        resources: this.resources,
        signal: providerSignal,
        children: {
          create: async (id, child) => {
            const model = await this.createCharacterModel(
              `${target}/${id}`,
              child as StoryCharacterEntry,
              providerSignal,
              [...ancestry, identity],
            );
            if (!model) throw new Error(`No character provider accepts component ${id}`);
            return model;
          },
          dispose: (model) => {
            if (!isThreeStoryCharacterModel(model)) throw new TypeError("Invalid child character model");
            return this.disposeCharacterModelSafely(model, "composite component disposal");
          },
        },
      };
      const model = await createRendererCharacterModel(provider, providerContext);
      if (!isThreeStoryCharacterModel(model)) {
        await disposeRendererCharacterModel(provider, model, providerContext);
        throw new TypeError(`Character provider ${provider.id} returned an incompatible model for ${this.rendererId}`);
      }
      this.characterModelDisposers.set(model, () => disposeRendererCharacterModel(provider, model, providerContext));
      model.setMotionSpeed(this.playbackSpeedRate);
      model.setRendererLighting?.(this.characterLightingState);
      return model;
    }

    const portraitUrl = firstString(normalizedEntry.runtime?.imageUrl);
    if (!portraitUrl || !this.staticPortraitFallback) {
      const runtime = record(normalizedEntry.runtime);
      const hasDynamicSource = [
        runtime.model,
        runtime.moc,
        runtime.skeleton,
        runtime.skel,
        runtime.json,
        runtime.atlas,
        runtime.format,
      ].some((value) => firstString(value));
      if (hasDynamicSource) {
        throw new Error(`No renderer-aware character plugin supports model ${target}`);
      }
      return null;
    }
    const renderer = this.renderer;
    if (!renderer) return null;
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error("Three character rendering requires WebGL2");
    }
    const runtime = normalizedEntry.runtime;
    const activeStage = record(this.state.stage);
    const model = await StaticPortraitModel.create({
      gl,
      signal,
      imageUrl: portraitUrl,
      resources: this.resources,
      pixelsPerUnit:
        positiveFinite(runtime?.pixelsPerUnit) ??
        positiveFinite(activeStage.characterPixelsPerUnit) ??
        positiveFinite(this.runtime.stage.characterPixelsPerUnit),
      worldHeight:
        positiveFinite(runtime?.worldHeight) ??
        positiveFinite(activeStage.characterCanvasWorldHeight) ??
        positiveFinite(this.runtime.stage.characterCanvasWorldHeight),
      pivot: runtime?.pivot,
      anisotropy: positiveFinite(
        record(this.runtime).characterTextureMaxAnisotropy ?? record(this.runtime).live2dTextureMaxAnisotropy,
      ),
    });
    model?.setMotionSpeed(this.playbackSpeedRate);
    return model;
  }

  private async createPreloadedCharacter(
    cmd: AdvCommand,
    target: string,
    identity: string,
    positionType: number,
    motions: readonly string[],
    expressions: readonly string[],
    commandIndex: number,
    signal: AbortSignal,
  ): Promise<StoryCharacter | null> {
    const entry = cmd.characterModel as StoryCharacterEntry | undefined;
    if (!entry) return null;
    // Vega has already scanned every authored In/Motion/Expression for this
    // controller, including defaults only where playback actually invokes
    // them. The renderer must not widen that exact set to the full catalogue.
    const motionNames = new Set(motions.filter(Boolean));
    const expressionNames = new Set(expressions.filter(Boolean));
    const declaredMotionNames = new Set(
      advCharacterMotions(entry)
        .map((animation) => firstString(record(animation).name))
        .filter(Boolean),
    );
    const declaredExpressionNames = new Set(
      advCharacterExpressions(entry)
        .map((animation) => firstString(record(animation).name))
        .filter(Boolean),
    );

    while (!this.destroyed && !signal.aborted) {
      if (!(await this.waitForRenderableContext(signal))) return null;
      const contextGeneration = this.contextRestoreGeneration;
      let model: ThreeStoryCharacterModel | null = null;
      let item: StoryCharacter | null = null;
      try {
        model = await this.createCharacterModel(target, entry, signal);
        if (!model) return null;
        if (this.destroyed || signal.aborted || !this.isRenderableContextGenerationCurrent(contextGeneration)) {
          this.disposeCharacterModelSafely(model, "stale renderer-ready preload", target);
          if (!signal.aborted && !this.destroyed) continue;
          return null;
        }
        item = new StoryCharacter(target, String(cmd.characterKey || ""), entry, model, Number(positionType) || 5);
        const normalizedEntry = this.normalizeCharacterModelEntry(entry);
        const modelIdentity = firstString(
          normalizedEntry.runtime?.model,
          normalizedEntry.runtime?.moc,
          normalizedEntry.runtime?.skeleton,
          normalizedEntry.runtime?.skel,
          normalizedEntry.runtime?.json,
          normalizedEntry.runtime?.imageUrl,
        );
        item.lipSync.randomSeed.value = hashSeed(`${cmd.characterKey || modelIdentity}:${target}`);
        item.alpha = 0;
        item.blurIntensity =
          item.positionType === this.cameraState.focusPositionType ? 0 : this.fieldRendererState.characterBlur;
        this.layoutCharacter(item);
        await this.configureModelMultiplyTexture(model, this.stageMultiplyTextureVersion);
        const selectedMotions = [...motionNames].filter(
          (name) => model!.hasMotion(name) || declaredMotionNames.has(name),
        );
        const selectedExpressions = [...expressionNames].filter((name) =>
          typeof model!.hasExpression === "function" ? model!.hasExpression(name) : declaredExpressionNames.has(name),
        );
        const [preparedMotions, preparedExpressions] = await Promise.all([
          Promise.all(selectedMotions.map((name) => model!.prepareMotion(name))),
          Promise.all(selectedExpressions.map((name) => model!.prepareExpression(name))),
        ]);
        for (let index = 0; index < selectedMotions.length; index += 1) {
          const name = selectedMotions[index]!;
          if (!preparedMotions[index]) {
            throw new Error(`Character motion ${name} could not be prepared`);
          }
        }
        for (let index = 0; index < selectedExpressions.length; index += 1) {
          const name = selectedExpressions[index]!;
          if (!preparedExpressions[index]) {
            throw new Error(`Character expression ${name} could not be prepared`);
          }
        }
        const preparedMotionNames = new Set(selectedMotions);
        const preparedExpressionNames = new Set(selectedExpressions);
        for (const name of preparedMotionNames) item.warmedMotionNames.add(name);
        for (const name of selectedExpressions) {
          item.warmedExpressionNames.add(name);
        }
        const presentationFadeIn = finite(
          entry.profile?.presentationFadeInSeconds,
          finite(record(entry.runtime).presentationFadeInSeconds, 0),
        );
        const initialMotionName = firstString(
          cmd.characterPresentation?.motionName,
          cmd.motionName,
          entry.profile?.defaultMotionName,
          record(entry.runtime).defaultMotionName,
        );
        const initialExpressionName = firstString(
          cmd.characterPresentation?.expressionName,
          cmd.expressionName,
          entry.profile?.defaultExpressionName,
          record(entry.runtime).defaultExpressionName,
        );
        const defaultMotionName = entry.profile?.playDefaultMotionBeforePresentation
          ? firstString(entry.profile?.defaultMotionName, record(entry.runtime).defaultMotionName)
          : "";
        if (
          defaultMotionName &&
          defaultMotionName !== initialMotionName &&
          preparedMotionNames.has(defaultMotionName)
        ) {
          if (!model.playMotion(defaultMotionName, presentationFadeIn)) {
            throw new Error(`Prepared character motion ${defaultMotionName} could not start`);
          }
          item.currentMotionName = defaultMotionName;
          item.currentMotionFadeInSeconds = presentationFadeIn;
        }
        if (
          initialMotionName &&
          preparedMotionNames.has(initialMotionName) &&
          !model.playMotion(initialMotionName, presentationFadeIn)
        ) {
          throw new Error(`Prepared character motion ${initialMotionName} could not start`);
        }
        if (initialMotionName && preparedMotionNames.has(initialMotionName)) {
          item.currentMotionName = initialMotionName;
          item.currentMotionFadeInSeconds = presentationFadeIn;
        }
        if (
          initialExpressionName &&
          preparedExpressionNames.has(initialExpressionName) &&
          !model.playExpression(initialExpressionName, presentationFadeIn)
        ) {
          throw new Error(`Prepared character expression ${initialExpressionName} could not start`);
        }
        if (initialExpressionName && preparedExpressionNames.has(initialExpressionName)) {
          item.currentExpressionName = initialExpressionName;
          item.currentExpressionFadeInSeconds = presentationFadeIn;
          item.activeExpressionName = initialExpressionName;
          item.activeExpressionFadeInSeconds = presentationFadeIn;
        }
        model.primeInitialFrame(this.characterParameterFrame(item));
        await this.waitForCharacterFirstDraw(item, contextGeneration, signal);
        if (this.destroyed || signal.aborted || !this.isRenderableContextGenerationCurrent(contextGeneration)) {
          this.releaseUnownedPreloadedCharacter(item, "stale prepared character");
          if (!signal.aborted && !this.destroyed) continue;
          return null;
        }
        const existing = this.cachedCharacterControllers.get(identity);
        if (existing) {
          this.releaseUnownedPreloadedCharacter(item, "duplicate prepared character");
          return existing;
        }
        this.cachedCharacterControllers.set(identity, item);
        this.speculativeCharacterControllers.set(identity, item);
        this.speculativeCharacterCommandIndices.set(identity, Math.max(0, Math.floor(finite(commandIndex))));
        return item;
      } catch (error) {
        if (item) {
          this.releaseUnownedPreloadedCharacter(item, "failed character preload");
        } else if (model) {
          this.disposeCharacterModelSafely(model, "failed character preload", target);
        }
        if (!signal.aborted && !this.destroyed && !this.isRenderableContextGenerationCurrent(contextGeneration)) {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  private waitForCharacterFirstDraw(
    item: StoryCharacter,
    contextGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(sceneAbortError(`Character ${item.target} preload was aborted`));
    }
    return new Promise<void>((resolve, reject) => {
      let state: CharacterRenderPrimeState;
      const aborted = () =>
        this.settleCharacterRenderPrime(state, sceneAbortError(`Character ${item.target} preload was aborted`));
      signal.addEventListener("abort", aborted, { once: true });
      state = {
        item,
        contextGeneration,
        detach: () => signal.removeEventListener("abort", aborted),
        resolve,
        reject,
        fence: null,
      };
      this.characterRenderPrimes.set(item, state);
    });
  }

  private settleCharacterRenderPrime(state: CharacterRenderPrimeState, error?: unknown): void {
    if (this.characterRenderPrimes.get(state.item) !== state) return;
    this.characterRenderPrimes.delete(state.item);
    if (state.fence && this.renderer) {
      (this.renderer.getContext() as WebGL2RenderingContext).deleteSync(state.fence);
      state.fence = null;
    }
    state.detach();
    if (error === undefined) state.resolve();
    else state.reject(error);
  }

  private createRendererContext(
    renderer: WebGLRenderer,
    gl: WebGL2RenderingContext,
    effectTarget?: ThreeRendererEffectTarget,
  ): ThreeRendererContext {
    return {
      gl,
      threeRenderer: renderer,
      rendererId: this.rendererId,
      rendererAliases: [LEGACY_HANEOKA_THREE_RENDERER_ID],
      profile: this.profile,
      runtime: this.runtime,
      state: this.state,
      scene: this.scene,
      camera: this.camera,
      backgroundField: this.backgroundField,
      characterField: this.characterField,
      foregroundField: this.foregroundField,
      effectTarget,
    };
  }

  private async createCharacter(
    cmd: AdvCommand,
    target: string,
    positionType: number,
    token: { scene: number; target: number; signal: AbortSignal },
  ): Promise<StoryCharacter | null> {
    const entry = cmd.characterModel as StoryCharacterEntry | undefined;
    if (!entry || !this.isCharacterLoadCurrent(target, token)) return null;
    const normalizedIdentityEntry = this.normalizeCharacterModelEntry(entry);
    const modelIdentity = firstString(
      normalizedIdentityEntry.runtime?.model,
      normalizedIdentityEntry.runtime?.moc,
      normalizedIdentityEntry.runtime?.skeleton,
      normalizedIdentityEntry.runtime?.skel,
      normalizedIdentityEntry.runtime?.json,
      normalizedIdentityEntry.runtime?.imageUrl,
    );
    while (this.isCharacterLoadCurrent(target, token)) {
      if (!(await this.waitForRenderableContext(token.signal))) return null;
      const contextGeneration = this.contextRestoreGeneration;
      let model: ThreeStoryCharacterModel | null = null;
      let item: StoryCharacter | null = null;
      try {
        model = await this.createCharacterModel(target, entry, token.signal);
        if (!model) return null;
        model.setClockSuspended?.(true);
        if (!this.isCharacterLoadCurrent(target, token)) {
          this.disposeCharacterModelSafely(model, "superseded load", target);
          return null;
        }
        // A model may have fetched/decoded across a WebGL loss. Even if its SDK
        // wrapper reports success, resources created before that loss belong to
        // the invalid generation and must never enter the staged controller.
        if (!this.isRenderableContextGenerationCurrent(contextGeneration)) {
          this.disposeCharacterModelSafely(model, "context generation changed during load", target);
          continue;
        }
        item = new StoryCharacter(target, String(cmd.characterKey || ""), entry, model, positionType);
        const pendingPlacement = this.pendingCharacterPlacements.get(target);
        const pendingWorld = this.pendingCharacterWorldPositions.get(target);
        item.worldPosition =
          (pendingWorld?.token === token.target ? { ...pendingWorld.position } : null) ??
          (pendingPlacement?.token === token.target && pendingPlacement.worldPosition
            ? { ...pendingPlacement.worldPosition }
            : null) ??
          worldPosition(cmd.characterWorldTransition?.from) ??
          worldPosition(cmd.characterWorldPosition) ??
          worldPosition(cmd.characterWorldTransition?.to);
        item.lipSync.randomSeed.value = hashSeed(`${cmd.characterKey || modelIdentity}:${target}`);
        this.layoutCharacter(item);
        if (!this.stageCharacter(target, token.target, item)) {
          this.disposeCharacterModelSafely(model, "staging ownership changed", target);
          return null;
        }
        await this.configureModelMultiplyTexture(model, this.stageMultiplyTextureVersion);
        if (!this.isCharacterLoadCurrent(target, token)) {
          this.releaseStagedCharacter(target, item);
          return null;
        }
        if (!this.isRenderableContextGenerationCurrent(contextGeneration)) {
          this.releaseStagedCharacter(target, item);
          continue;
        }
        return item;
      } catch (error) {
        if (item) this.releaseStagedCharacter(target, item);
        else if (model) {
          this.disposeCharacterModelSafely(model, "failed creation", target);
        }
        if (!this.isCharacterLoadCurrent(target, token)) return null;
        // Context restoration is a retry boundary, not a failed ADV In. Keep
        // the pending command channels and reconstruct against the new GL state.
        if (!this.isRenderableContextGenerationCurrent(contextGeneration)) continue;
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
        this.cancelPendingCharacterLoadController(target, token.target);
        throw error;
      }
    }
    return null;
  }

  async placeCharacter(cmd: AdvCommand, positionType: number, duration = 0, _noWait = false): Promise<void> {
    const target = String(cmd.targetName || cmd.targets?.[0]?.target || "");
    if (!target) return;
    // Background seek-index compilation only needs the logical identity →
    // position → presentation mapping for checkpoints. Creating GPU models
    // here loaded every authored character on top of the playback set and
    // jetsam-killed iOS / froze desktops mid-episode through VRAM pressure.
    if (this.seekIndexCompilationActive) {
      const compileIdentity = firstString(
        record(cmd).controllerIdentity,
        `${target}\u0000${Number(cmd.targetAssetIndex) || 0}`,
      );
      this.characterControllerIdentities.set(target, compileIdentity);
      return;
    }
    const alphaOperationAtStart = this.characterAlphaOperations.get(target);
    const transitionFrom = worldPosition(cmd.characterWorldTransition?.from);
    const transitionTo = worldPosition(cmd.characterWorldTransition?.to);
    const initialWorldPosition = transitionFrom ?? worldPosition(cmd.characterWorldPosition) ?? transitionTo;
    const identity = firstString(record(cmd).controllerIdentity, `${target}\u0000${Number(cmd.targetAssetIndex) || 0}`);
    // TryGetCharacterController always consults the loader's current asset
    // index. Select this identity synchronously, before browser model loading.
    this.characterControllerIdentities.set(target, identity);
    const token = this.beginCharacterLoad(target, cmd);
    const entry = cmd.characterModel as StoryCharacterEntry | undefined;
    let pendingPlacement: PendingCharacterPlacement | null = null;
    if (entry) {
      pendingPlacement = {
        token: token.target,
        entry,
        positionType: Number(positionType) || 5,
        // Native controller instances are cached by TargetName+AssetIndex and
        // survive Out/In. Only a character/costume asset-index change selects
        // a different controller identity.
        identity,
        worldPosition: initialWorldPosition ? { ...initialWorldPosition } : null,
        fadeInDurationSeconds: Math.max(0, finite(duration)),
        fadeInStartedAtSeconds: null,
      };
      this.pendingCharacterPlacements.set(target, pendingPlacement);
      // The authored In transition begins when its command is issued, not
      // after model creation finishes. A slow network/SDK preparation must not
      // add a second full fade delay once the renderer-ready model arrives.
      void this.markPendingCharacterFadeInStarted(target, pendingPlacement);
    }
    let cached = this.cachedCharacterControllerByIdentity(identity);
    const activePreload = cached ? undefined : this.characterPreloads.get(identity);
    if (activePreload) {
      let detachAbort = () => {};
      try {
        await Promise.race([
          activePreload.promise,
          new Promise<void>((resolve) => {
            const aborted = () => resolve();
            token.signal.addEventListener("abort", aborted, { once: true });
            detachAbort = () => token.signal.removeEventListener("abort", aborted);
          }),
        ]);
      } catch (error) {
        // A failed speculative preload is not a failed CharacterIn. The normal
        // load path below remains the authoritative retry boundary.
        if (!token.signal.aborted) {
          console.warn(`Renderer-ready preload failed for character ${target}`, error);
        }
      } finally {
        detachAbort();
      }
      if (!this.isCharacterLoadCurrent(target, token)) return;
      cached = this.cachedCharacterControllerByIdentity(identity);
    }
    if (cached) {
      const pending = this.pendingCharacterCommands.consume(target, token.target) || {};
      this.pendingCharacterPlacements.delete(target);
      const pendingWorld = this.pendingCharacterWorldPositions.get(target);
      if (pendingWorld?.token === token.target) {
        this.pendingCharacterWorldPositions.delete(target);
      }
      this.completePendingCharacterLoadController(target, token.target);
      cached.positionType = Number(positionType) || 5;
      if (initialWorldPosition) cached.worldPosition = { ...initialWorldPosition };
      cached.paused = false;
      cached.pendingPausedMotion = null;
      cached.pendingPausedExpression = null;
      // AdvInCommand.AddSpeaker calls ResetAngleLook after showing the cached
      // controller. This wrapper-level reset is easy to miss because neither
      // model Show nor Hide owns it: every new In starts from motion
      // eye/head parameters until a following Angle/Look command takes over.
      this.resetCharacterAngleLook(cached);
      // RegisterCharacterEntry is recreated on every Show, so its blur starts
      // from the field renderer's current slot state rather than the hidden
      // entry that was removed by Out.
      cached.blurIntensity =
        cached.positionType === this.cameraState.focusPositionType ? 0 : this.fieldRendererState.characterBlur;
      this.invokeCharacterModel(cached, "show cached controller", undefined, (model) => {
        model.setPaused(false);
        model.setMotionSpeed(this.playbackSpeedRate);
      });
      cached.alpha = duration > 0 ? 0 : 1;
      // A renderer-ready preload can still be in flight when no-wait
      // Motion/Expression/Lip/Angle/Look/lighting commands arrive. Consume the
      // complete pending presentation, not only the two animation names.
      this.primeCharacterPresentation(cached, pending);
      this.registerVisibleCharacter(target, cached);
      this.layoutCharacter(cached);
      this.characterControllerIdentities.set(target, identity);
      this.scene.updateMatrixWorld(true);
      cached.node.getWorldPosition(this.renderWorldPosition);
      const authoredRenderOrder = Number(cmd.characterRenderOrder);
      cached.sortingOrder = Number.isFinite(authoredRenderOrder)
        ? authoredRenderOrder
        : threeVector3ToUnity(this.renderWorldPosition, this.renderUnityPosition).z;
      const fadeStartedAt = pendingPlacement?.fadeInStartedAtSeconds;
      const elapsed = fadeStartedAt == null ? 0 : Math.max(0, this.monotonicSeconds() - fadeStartedAt);
      const startRaw = duration > 0 ? clamp(elapsed / duration) : 1;
      const remainingDuration = duration * (1 - startRaw);
      const layoutMove =
        pendingWorld?.token === token.target
          ? this.moveCharacterToWorld(target, pendingWorld.position, pendingWorld.positionType, 0, 6)
          : transitionTo
            ? this.moveCharacterToWorld(target, transitionTo, cached.positionType, remainingDuration, 6)
            : Promise.resolve();
      const pendingAlphaOwnsFade = this.characterAlphaOperations.get(target) !== alphaOperationAtStart;
      if (duration > 0 && !pendingAlphaOwnsFade) {
        if (startRaw >= 1) cached.alpha = 1;
        await Promise.all([
          startRaw >= 1
            ? Promise.resolve(true)
            : this.fadeCharacterLifecycle(cached, 0, 1, remainingDuration, {
                delayFrames: fadeStartedAt == null ? undefined : 0,
                startRaw,
              }),
          layoutMove,
        ]);
      } else {
        await layoutMove;
      }
      return;
    }
    const item = await this.createCharacter(cmd, target, Number(positionType) || 5, token);
    if (!item) {
      if (this.isCharacterLoadCurrent(target, token)) {
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
        this.cancelPendingCharacterLoadController(target, token.target);
      }
      return;
    }
    if (!this.isCharacterLoadCurrent(target, token)) {
      this.releaseStagedCharacter(target, item);
      return;
    }
    let registered = false;
    try {
      registered = await this.prepareAndRegisterInitialCharacterPresentation(item, target, token, duration);
    } catch (error) {
      if (this.characterItems.get(target) === item) this.characterItems.delete(target);
      this.releaseStagedCharacter(target, item);
      item.angleTweenController?.abort();
      item.lookTweenController?.abort();
      item.node.removeFromParent();
      if (this.isCharacterLoadCurrent(target, token)) {
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
      }
      throw error;
    }
    if (!registered) {
      this.releaseStagedCharacter(target, item);
      if (this.isCharacterLoadCurrent(target, token)) {
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
      }
      return;
    }
    // Registration happened atomically with pending-state consumption below.
    // A later command may already have removed/replaced the item while this
    // outer async continuation was waiting to resume.
    if (!this.isCharacterLoadCurrent(target, token) || this.characterItems.get(target) !== item) return;
    // AdvFieldRenderPass.RegisterCharacterEntry stores the controller's Unity
    // world-position z once, then OrderByDescending uses that value before the
    // position-priority tie breaker.
    this.scene.updateMatrixWorld(true);
    item.node.getWorldPosition(this.renderWorldPosition);
    const authoredRenderOrder = Number(cmd.characterRenderOrder);
    item.sortingOrder = Number.isFinite(authoredRenderOrder)
      ? authoredRenderOrder
      : threeVector3ToUnity(this.renderWorldPosition, this.renderUnityPosition).z;
    const pendingWorld = this.pendingCharacterWorldPositions.get(target);
    if (pendingWorld?.token === token.target) this.pendingCharacterWorldPositions.delete(target);
    const fadeStartedAt = pendingPlacement?.fadeInStartedAtSeconds;
    const elapsed = fadeStartedAt == null ? 0 : Math.max(0, this.monotonicSeconds() - fadeStartedAt);
    const startRaw = duration > 0 ? clamp(elapsed / duration) : 1;
    const remainingDuration = duration * (1 - startRaw);
    const layoutMove =
      pendingWorld?.token === token.target
        ? this.moveCharacterToWorld(target, pendingWorld.position, pendingWorld.positionType, 0, 6)
        : transitionTo
          ? this.moveCharacterToWorld(target, transitionTo, item.positionType, remainingDuration, 6)
          : Promise.resolve();
    const pendingAlphaOwnsFade = this.characterAlphaOperations.get(target) !== alphaOperationAtStart;
    if (duration > 0 && !pendingAlphaOwnsFade) {
      // A newer Out/replacement owns cleanup after it cancels this position's
      // fade. The obsolete In continuation must never release mid-fade.
      if (startRaw >= 1) item.alpha = 1;
      await Promise.all([
        startRaw >= 1
          ? Promise.resolve(true)
          : this.fadeCharacterLifecycle(item, 0, 1, remainingDuration, {
              delayFrames: fadeStartedAt == null ? undefined : 0,
              startRaw,
            }),
        layoutMove,
      ]);
    } else {
      await layoutMove;
    }
  }

  /**
   * Registration and pending-state consumption intentionally share one
   * synchronous segment. A following Talk can therefore always find either
   * the in-flight pending slot or the registered character; there is no
   * promise-continuation gap in which the first lip-sync can be dropped.
   */
  private primeCharacterPresentation(item: StoryCharacter, pending: PendingCharacterPresentation): void {
    // Unity's character and its animation assets already exist when ADV Show
    // runs; Show selects the supplied name or the default once per channel
    // (the provider controller's Show step). The browser model may still be
    // loading, so issuing both default and pending requests would create an
    // artificial race in which a late default can overwrite authored state.
    const { motionName, expressionName, activeMotionName, activeExpressionName, hasPausedMotion, hasPausedExpression } =
      this.resolveCharacterPresentationChannels(item, pending);
    const defaultFadeInSeconds = this.defaultCharacterPresentationFadeIn(item);
    const defaultMotionName = firstString(
      item.entry.profile?.defaultMotionName,
      record(item.entry.runtime).defaultMotionName,
    );
    if (
      item.entry.profile?.playDefaultMotionBeforePresentation &&
      defaultMotionName &&
      activeMotionName &&
      activeMotionName !== defaultMotionName
    ) {
      this.invokeCharacterModel(item, "prime default motion", false, (model) =>
        model.playMotion(defaultMotionName, defaultFadeInSeconds),
      );
    }
    // AdvCharacterHelper.Show defaults its fadeIn argument to 0. A pending
    // command carries the command's explicit value (including -1); otherwise
    // the default Show motion/expression must also be applied immediately.
    if (activeMotionName) {
      const fadeInSeconds = hasPausedMotion
        ? (pending.activeMotion?.fadeInSeconds ?? defaultFadeInSeconds)
        : (pending.motion?.fadeInSeconds ?? defaultFadeInSeconds);
      item.currentMotionName = activeMotionName;
      item.currentMotionFadeInSeconds = fadeInSeconds;
      this.invokeCharacterModel(item, "play initial motion", false, (model) =>
        model.playMotion(activeMotionName, fadeInSeconds),
      );
    }
    if (hasPausedMotion && motionName && pending.motion) {
      item.pendingPausedMotion = { name: motionName, fadeInSeconds: pending.motion.fadeInSeconds };
    }
    if (activeExpressionName) {
      const fadeInSeconds = hasPausedExpression
        ? (pending.activeExpression?.fadeInSeconds ?? defaultFadeInSeconds)
        : (pending.expression?.fadeInSeconds ?? defaultFadeInSeconds);
      item.activeExpressionName = activeExpressionName;
      item.activeExpressionFadeInSeconds = fadeInSeconds;
      this.invokeCharacterModel(item, "play initial expression", false, (model) =>
        model.playExpression(activeExpressionName, fadeInSeconds),
      );
    }
    item.currentExpressionName = firstString(pending.currentExpressionName, expressionName);
    item.currentExpressionFadeInSeconds = pending.currentExpressionFadeInSeconds;
    if (hasPausedExpression && expressionName && pending.expression) {
      item.pendingPausedExpression = { name: expressionName, fadeInSeconds: pending.expression.fadeInSeconds };
    }
    if (pending?.lipSync) {
      this.restorePendingLipSync(item, pending.lipSync, pending.pauseEvents || []);
      this.updateLipSync(item, 0);
    }
    if (pending.angleOverridePrepared) item.angleOverride = true;
    if (pending.angleEvents?.length) this.restorePendingAngle(item, pending.angleEvents);
    if (pending.brightnessEvents?.length) this.restorePendingBrightness(item, pending.brightnessEvents);
    if (pending.alphaEvents?.length) this.restorePendingAlpha(item, pending.alphaEvents);
    if (pending.rimLightEvents?.length) this.restorePendingRimLight(item, pending.rimLightEvents);
    if (pending.dofEvents?.length) this.restorePendingDoF(item, pending.dofEvents);
    if (pending.paused != null) {
      item.paused = pending.paused;
      this.invokeCharacterModel(item, "apply initial pause state", undefined, (model) => model.setPaused(item.paused));
    }
    this.invokeCharacterModel(item, "prime initial frame", undefined, (model) =>
      model.primeInitialFrame(this.characterParameterFrame(item)),
    );
    if (pending.lookEvents?.length) {
      this.restorePendingLook(item, pending.lookEvents, Boolean(pending.lookOverridePrepared));
    } else if (pending.lookOverridePrepared) this.enableLookOverride(item);
  }

  private resolveInitialCharacterPresentation(
    item: StoryCharacter,
    pending: PendingCharacterPresentation | null,
  ): { motionName: string; expressionName: string } {
    return {
      motionName: firstString(
        pending?.motion?.name,
        item.entry.profile?.defaultMotionName,
        record(item.entry.runtime).defaultMotionName,
      ),
      expressionName: firstString(
        pending?.expression?.name,
        item.entry.profile?.defaultExpressionName,
        record(item.entry.runtime).defaultExpressionName,
      ),
    };
  }

  private defaultCharacterPresentationFadeIn(item: StoryCharacter): number {
    return finite(
      item.entry.profile?.presentationFadeInSeconds,
      finite(record(item.entry.runtime).presentationFadeInSeconds, 0),
    );
  }

  private resolveCharacterPresentationChannels(item: StoryCharacter, pending: PendingCharacterPresentation) {
    const { motionName, expressionName } = this.resolveInitialCharacterPresentation(item, pending);
    const defaultMotionName = firstString(
      item.entry.profile?.defaultMotionName,
      record(item.entry.runtime).defaultMotionName,
    );
    const defaultExpressionName = firstString(
      item.entry.profile?.defaultExpressionName,
      record(item.entry.runtime).defaultExpressionName,
    );
    const hasPausedMotion = Boolean(pending.paused && pending.motionQueuedWhilePaused && pending.motion);
    const hasPausedExpression = Boolean(pending.paused && pending.expressionQueuedWhilePaused && pending.expression);
    return {
      motionName,
      expressionName,
      activeMotionName: hasPausedMotion ? firstString(pending.activeMotion?.name, defaultMotionName) : motionName,
      activeExpressionName: hasPausedExpression
        ? firstString(pending.activeExpression?.name, defaultExpressionName)
        : expressionName,
      hasPausedMotion,
      hasPausedExpression,
    };
  }

  /**
   * The reference ADV runtime loads character animation assets before Show and applies Show's selected
   * motion/expression before enabling the renderer. Browser resource fetches are
   * asynchronous, so keep the item outside characterItems until the latest
   * pending pair has been parsed. A command arriving during an await replaces
   * the single pending slot; the loop then prepares that newer pair instead.
   */
  private async prepareAndRegisterInitialCharacterPresentation(
    item: StoryCharacter,
    target: string,
    token: { scene: number; target: number; signal: AbortSignal },
    duration: number,
  ): Promise<boolean> {
    while (this.isCharacterLoadCurrent(target, token)) {
      if (!(await this.waitForRenderableContext(token.signal))) return false;
      const contextGeneration = this.contextRestoreGeneration;
      // A staged controller is part of context restoration. If its first rebuild
      // failed, the supervised single-flight recovery owns the model until it
      // installs a replacement; do not consume pending Motion/Expression early.
      while (
        this.isCharacterLoadCurrent(target, token) &&
        this.isRenderableContextGenerationCurrent(contextGeneration) &&
        this.characterModelRecoveryStates.has(item)
      ) {
        await nextFrame();
      }
      if (!this.isCharacterLoadCurrent(target, token)) return false;
      if (!this.isRenderableContextGenerationCurrent(contextGeneration)) continue;
      const before = this.pendingCharacterCommands.peek(target, token.target);
      if (!before) return false;
      const names = this.resolveCharacterPresentationChannels(item, before);
      const resourceChange = this.pendingCharacterCommands.observeResourceChange(target, token.target);
      if (!resourceChange) return false;
      const defaultMotionName = item.entry.profile?.playDefaultMotionBeforePresentation
        ? firstString(item.entry.profile?.defaultMotionName, record(item.entry.runtime).defaultMotionName)
        : "";
      const motionNames = [...new Set([defaultMotionName, names.motionName, names.activeMotionName].filter(Boolean))];
      const expressionNames = [...new Set([names.expressionName, names.activeExpressionName].filter(Boolean))];
      const prepared = Promise.all([
        Promise.all(
          motionNames.map((name) =>
            this.invokeCharacterModelTask(item, `prepare motion ${name}`, false, (model) => model.prepareMotion(name)),
          ),
        ),
        Promise.all(
          expressionNames.map((name) =>
            this.invokeCharacterModelTask(item, `prepare expression ${name}`, false, (model) =>
              model.prepareExpression(name),
            ),
          ),
        ),
      ]).then(() => ({ kind: "prepared" as const }));
      const outcome = await Promise.race([prepared, resourceChange.changed.then(() => ({ kind: "changed" as const }))]);
      if (!this.isRenderableContextGenerationCurrent(contextGeneration)) continue;
      if (outcome.kind === "changed") continue;
      if (!this.isCharacterLoadCurrent(target, token)) return false;
      const after = this.pendingCharacterCommands.peek(target, token.target);
      if (!after) return false;
      const currentNames = this.resolveCharacterPresentationChannels(item, after);
      if (
        currentNames.motionName === names.motionName &&
        currentNames.expressionName === names.expressionName &&
        currentNames.activeMotionName === names.activeMotionName &&
        currentNames.activeExpressionName === names.activeExpressionName &&
        currentNames.hasPausedMotion === names.hasPausedMotion &&
        currentNames.hasPausedExpression === names.hasPausedExpression
      ) {
        // Provider PlayMotion/PlayExpression calls use resource lookup and simply
        // return when an authored key is absent. In particular, Mujica 1 has
        // `mtn_surprise01_R` while Mutsumi's bundle contains
        // `mtn_surprised01_R`; that typo must not turn CharacterIn into a
        // failed model load. Preparation still eagerly parses every available
        // channel, while playMotion/playExpression below preserve the native
        // non-fatal lookup semantics for missing entries.
        // No await is allowed from this final validation through registration.
        // ADV can keep dispatching no-wait commands while assets load; keeping
        // this segment synchronous prevents both an unprepared late override
        // and a consume-before-register command-loss window.
        const pending = this.pendingCharacterCommands.consume(target, token.target);
        if (!pending) return false;
        item.alpha = duration > 0 ? 0 : 1;
        item.blurIntensity =
          item.positionType === this.cameraState.focusPositionType ? 0 : this.fieldRendererState.characterBlur;
        this.primeCharacterPresentation(item, pending);
        return this.commitStagedCharacter(target, token.target, item);
      }
    }
    return false;
  }

  async removeCharacter(target: string, duration = 0): Promise<boolean> {
    if (this.seekIndexCompilationActive) return true;
    const wasPending = this.pendingCharacterPlacements.has(target) || this.stagedCharacterItems.has(target);
    this.invalidateCharacterLoad(target);
    this.characterPresentationHistory.delete(target);
    const item = this.characterItems.get(target);
    if (!item) {
      this.cancelCharacterOwnedTweens(target);
      return wasPending;
    }
    const owns = await this.fadeCharacterLifecycle(item, item.alpha, 0, duration);
    if (!owns || this.characterItems.get(target) !== item) return false;
    // AdvOut keeps Angle/Look running through FadeOutCharacterAsync. Hide then
    // unregisters only the renderer entry; the loader's controller survives.
    this.cancelCharacterOwnedTweens(target);
    // Provider Hide normally clears pause state before
    // ResetExpressionParametersToDefault/FlushExpressionResetToDrawableState.
    // Some source viewers retain the controller's presentation across Hide;
    // keep that provider-specific state on the cached controller.
    const preservePresentation = item.entry.profile?.preservePresentationOnHide === true;
    item.paused = false;
    item.pendingPausedMotion = null;
    item.pendingPausedExpression = null;
    if (!preservePresentation) {
      item.activeExpressionName = "";
      item.activeExpressionFadeInSeconds = undefined;
    }
    this.invokeCharacterModel(item, "hide controller", undefined, (model) => {
      model.setClockSuspended?.(true);
      model.setPaused(false);
      if (!preservePresentation) model.resetExpressionParametersToDefault();
    });
    this.characterItems.delete(target);
    // Hide/Unregister does not evict the loader's TargetName+Asset controller.
    // Keep its transform, model, angle/look state and queued motion alive while
    // excluding it from the manually rendered showing map.
    return true;
  }

  async fadeCharacter(target: string, alpha: number, duration = 0): Promise<void> {
    const targetAlpha = clamp(alpha);
    const seconds = Math.max(0, finite(duration));
    const operationId = ++this.characterAlphaOperationSequence;
    this.characterAlphaOperations.set(target, operationId);
    const item = this.cachedCharacterController(target);
    if (item) {
      await this.fadeCharacterLifecycle(item, item.alpha, targetAlpha, seconds);
      return;
    }

    const token = this.selectedPendingCharacterToken(target);
    const queuedAtSeconds = this.monotonicSeconds();
    if (
      token == null ||
      !this.pendingCharacterCommands.queueAlpha(
        target,
        token,
        {
          operationId,
          value: targetAlpha,
          durationSeconds: seconds,
          queuedAtSeconds,
          startedAtSeconds: null,
        },
        this.pendingCharacterFadeInAlpha(target, token, queuedAtSeconds),
      )
    ) {
      return;
    }

    // FadeCharacterAsync captures and writes the current alpha, then waits
    // three Update frames before constructing its DOTween. Native always has a
    // preloaded controller; this gate lets a browser controller that resolves
    // during those frames enter the same phase without delaying it twice.
    for (let frame = 0; frame < UNITY_CHARACTER_FADE_DELAY_FRAMES; frame += 1) await nextFrame();
    if (this.characterAlphaOperations.get(target) !== operationId) return;
    const loaded = this.cachedCharacterController(target);
    if (loaded) {
      await this.fadeCharacterLifecycle(loaded, loaded.alpha, targetAlpha, seconds, {
        delayFrames: 0,
      });
      return;
    }
    if (!this.pendingCharacterCommands.markAlphaStarted(target, token, operationId, this.monotonicSeconds())) return;
    await this.runTween({ duration: seconds });
  }

  private async fadeCharacterLifecycle(
    item: StoryCharacter,
    from: number,
    to: number,
    duration: number,
    resumed: { readonly delayFrames?: number; readonly startRaw?: number } = {},
  ): Promise<boolean> {
    return this.characterFadeCoordinator.fade(item.positionType, {
      from,
      to,
      duration,
      delayFrames: resumed.delayFrames,
      startRaw: resumed.startRaw,
      setAlpha: (alpha) => {
        item.alpha = alpha;
      },
      waitFrame: nextFrame,
      tween: (seconds, update) => this.runTween({ duration: seconds, update }),
    });
  }

  /**
   * Reset command ownership and visibility without releasing renderer-ready
   * character controllers. Seek snapshots are logical presentation states;
   * retaining the episode cache makes the loading-phase model warmup survive
   * both scene-index compilation and every later progress jump.
   */
  private prepareCharactersForSeekRestore(): void {
    this.cancelAllCharacterModelRecoveries();
    this.cancelAllCharacterOwnedTweens();
    this.characterAlphaOperations.clear();
    for (const pending of this.pendingCharacterLoadControllers.values()) {
      pending.detach();
      pending.controller.abort();
    }
    this.pendingCharacterLoadControllers.clear();
    this.pendingCharacterCommands.clear();
    this.pendingCharacterPlacements.clear();
    this.pendingCharacterWorldPositions.clear();
    for (const controller of this.pendingAngleWaitControllers.values()) controller.abort();
    this.pendingAngleWaitControllers.clear();
    for (const controller of this.pendingLookWaitControllers.values()) controller.abort();
    this.pendingLookWaitControllers.clear();
    this.characterPresentationHistory.clear();
    for (const item of this.characterItems.values()) {
      this.characterFadeCoordinator.cancel(item.positionType);
    }
    this.characterItems.clear();
    this.speculativeCharacterControllers.clear();
    this.speculativeCharacterCommandIndices.clear();
    this.characterControllerIdentities.clear();
    this.sortedCharacterItems.length = 0;
    for (const group of this.characterRenderGroupPool) group.items.length = 0;
  }

  clearCharacters(): void {
    this.cancelAllCharacterModelRecoveries();
    this.cancelAllCharacterOwnedTweens();
    for (const [identity, preload] of this.characterPreloads) {
      this.discardedCharacterPreloadIdentities.add(identity);
      preload.detach();
      preload.controller.abort();
    }
    this.characterPreloads.clear();
    this.notifyCharacterPreloadCapacity();
    for (const prime of [...this.characterRenderPrimes.values()]) {
      this.settleCharacterRenderPrime(prime, sceneAbortError(`Character ${prime.item.target} preload was cleared`));
    }
    this.characterLoadTokens.clear();
    this.characterAlphaOperations.clear();
    for (const pending of this.pendingCharacterLoadControllers.values()) {
      pending.detach();
      pending.controller.abort();
    }
    this.pendingCharacterLoadControllers.clear();
    this.pendingCharacterCommands.clear();
    this.pendingCharacterPlacements.clear();
    this.pendingCharacterWorldPositions.clear();
    for (const controller of this.pendingAngleWaitControllers.values()) controller.abort();
    this.pendingAngleWaitControllers.clear();
    for (const controller of this.pendingLookWaitControllers.values()) controller.abort();
    this.pendingLookWaitControllers.clear();
    this.characterPresentationHistory.clear();
    for (const target of [...this.stagedCharacterItems.keys()]) this.releaseStagedCharacter(target);
    for (const identity of this.cachedCharacterControllers.keys()) {
      this.discardedCharacterPreloadIdentities.add(identity);
    }
    const controllers = new Set<StoryCharacter>([
      ...this.cachedCharacterControllers.values(),
      ...this.characterItems.values(),
    ]);
    for (const item of controllers) {
      item.angleTweenController?.abort();
      item.lookTweenController?.abort();
      this.characterFadeCoordinator.cancel(item.positionType);
      item.node.removeFromParent();
      this.releaseCharacterModelSafely(item, "scene character clear");
    }
    this.characterItems.clear();
    this.cachedCharacterControllers.clear();
    this.speculativeCharacterControllers.clear();
    this.speculativeCharacterCommandIndices.clear();
    this.notifyCharacterPreloadCapacity();
    this.characterControllerIdentities.clear();
    this.sortedCharacterItems.length = 0;
    for (const group of this.characterRenderGroupPool) group.items.length = 0;
  }

  playMotionForTarget(target: string, motionName = "", motionFadeIn = -1, expectedIdentity?: string): void {
    const item = expectedIdentity
      ? this.cachedCharacterControllerByIdentity(expectedIdentity)
      : this.cachedCharacterController(target);
    const placement = this.pendingCharacterPlacements.get(target);
    if (item) {
      // The provider checks its loaded motion map before it
      // mutates either the active player or the paused pending slot. Keep a
      // missing key out of snapshot history as well, so seek restores the last
      // motion that actually became active instead of falling back to idle.
      const hasMotion = this.invokeCharacterModel(
        item,
        `query motion ${motionName}`,
        this.hasCharacterPresentationResource(item.entry, "motions", motionName),
        (model) => model.hasMotion(motionName),
      );
      if (!hasMotion) return;
      if (item.paused) {
        this.recordCharacterPresentation(target, { kind: "motion", name: motionName });
        // The provider keeps one pending motion slot while paused; the
        // latest command replaces the earlier request and plays on Resume.
        item.pendingPausedMotion = { name: motionName, fadeInSeconds: motionFadeIn };
        return;
      }
      this.recordCharacterPresentation(target, { kind: "motion", name: motionName });
      item.currentMotionName = motionName;
      item.currentMotionFadeInSeconds = motionFadeIn;
      this.invokeCharacterModel(item, `play motion ${motionName}`, false, (model) =>
        model.playMotion(motionName, motionFadeIn),
      );
      return;
    }
    // Before browser CharacterIn has produced a controller, use the prepared
    // data map to preserve the default/previous pending motion on a missing
    // authored key. This is the asynchronous equivalent of native TryGetValue.
    if (!this.hasCharacterPresentationResource(placement?.entry, "motions", motionName)) return;
    this.recordCharacterPresentation(target, { kind: "motion", name: motionName });
    const token = this.selectedPendingCharacterToken(target);
    const pendingIdentity = placement?.identity;
    if (token != null && (!expectedIdentity || pendingIdentity === expectedIdentity)) {
      this.pendingCharacterCommands.queueMotion(target, token, { name: motionName, fadeInSeconds: motionFadeIn });
    }
  }

  playExpressionForTarget(
    target: string,
    expressionName = "",
    fadeInSeconds?: number,
    expectedIdentity?: string,
  ): void {
    const item = expectedIdentity
      ? this.cachedCharacterControllerByIdentity(expectedIdentity)
      : this.cachedCharacterController(target);
    const placement = this.pendingCharacterPlacements.get(target);
    const entry = item?.entry || placement?.entry;
    const resolvedName = firstString(
      expressionName,
      entry?.profile?.defaultExpressionName,
      record(entry?.runtime).defaultExpressionName,
    );
    if (!item) {
      if (!this.hasCharacterPresentationResource(entry, "expressions", resolvedName)) return;
      this.recordCharacterPresentation(target, { kind: "expression", name: resolvedName });
      const token = this.selectedPendingCharacterToken(target);
      const pendingIdentity = placement?.identity;
      if (token != null && (!expectedIdentity || pendingIdentity === expectedIdentity)) {
        this.pendingCharacterCommands.queueExpression(target, token, { name: resolvedName, fadeInSeconds });
      }
      return;
    }
    // The controller records CurrentExpressionName/fade before delegating to
    // provider model; a missing underlying expression therefore still
    // changes duplicate-request bookkeeping even though the model map lookup
    // itself is a no-op.
    this.recordCharacterPresentation(target, { kind: "expression", name: resolvedName });
    // The provider controller only refreshes its fade field when the same
    // expression is requested again; it neither restarts the expression nor
    // fills the single Pause pending slot.
    if (this.characterItems.get(target) === item && item.currentExpressionName === resolvedName) {
      item.currentExpressionFadeInSeconds = fadeInSeconds;
      if (!item.paused && item.activeExpressionName === resolvedName) {
        item.activeExpressionFadeInSeconds = fadeInSeconds;
      }
      this.invokeCharacterModel(item, `refresh expression ${resolvedName}`, undefined, (model) =>
        model.refreshCurrentExpressionFadeIn(resolvedName, fadeInSeconds),
      );
      return;
    }
    item.currentExpressionName = resolvedName;
    item.currentExpressionFadeInSeconds = fadeInSeconds;
    if (item.paused) {
      // Controller-side name/fade fields are already updated above, but the
      // underlying provider model returns on a failed data-map lookup before
      // assigning its paused pending expression.
      if (!this.hasCharacterPresentationResource(item.entry, "expressions", resolvedName)) return;
      item.pendingPausedExpression = { name: resolvedName, fadeInSeconds };
      return;
    }
    item.activeExpressionName = resolvedName;
    item.activeExpressionFadeInSeconds = fadeInSeconds;
    this.invokeCharacterModel(item, `play expression ${resolvedName}`, false, (model) =>
      model.playExpression(resolvedName, fadeInSeconds),
    );
  }

  setCharacterForward(positionType: number): void {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return;
    // Native mutates the current render-pass priority list (Remove + Add), so
    // successive Forward/Back commands must preserve earlier rearrangements.
    this.characterPriorityOrder = this.characterPriorityOrder.filter((value) => value !== index);
    this.characterPriorityOrder.push(index);
  }

  setCharacterBack(positionType: number): void {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return;
    this.characterPriorityOrder = [index, ...this.characterPriorityOrder.filter((value) => value !== index)];
  }

  sortCharacters(): void {
    this.characterPriorityOrder = [4, 0, 3, 1, 2];
    this.applyTransforms();
    this.scene.updateMatrixWorld(true);
    for (const item of this.characterItems.values()) {
      item.node.getWorldPosition(this.renderWorldPosition);
      item.sortingOrder = threeVector3ToUnity(this.renderWorldPosition, this.renderUnityPosition).z;
    }
  }

  setCharacterPaused(target: string, paused: boolean): void {
    const item = this.cachedCharacterController(target);
    if (item) {
      item.paused = paused;
      let motion: { name: string; fadeInSeconds?: number } | null = null;
      let expression: { name: string; fadeInSeconds?: number } | null = null;
      if (!paused) {
        motion = item.pendingPausedMotion;
        expression = item.pendingPausedExpression;
        item.pendingPausedMotion = null;
        item.pendingPausedExpression = null;
        if (motion) {
          item.currentMotionName = motion.name;
          item.currentMotionFadeInSeconds = motion.fadeInSeconds;
        }
        if (expression) {
          item.activeExpressionName = expression.name;
          item.activeExpressionFadeInSeconds = expression.fadeInSeconds;
        }
      }
      this.invokeCharacterModel(item, paused ? "pause" : "resume", undefined, (model) => {
        model.setPaused(paused);
        if (motion) model.playMotion(motion.name, motion.fadeInSeconds);
        if (expression) model.playExpression(expression.name, expression.fadeInSeconds);
      });
      return;
    }
    const token = this.selectedPendingCharacterToken(target);
    if (token != null) {
      this.pendingCharacterCommands.queuePaused(target, token, paused, this.monotonicSeconds());
    }
  }

  /** Native showing controllers, including Web-only asynchronous In staging. */
  showingCharacterTargets(): string[] {
    const targets = new Set(this.characterItems.keys());
    for (const [target, pending] of this.pendingCharacterPlacements) {
      if (this.characterLoadTokens.get(target) === pending.token) targets.add(target);
    }
    return [...targets];
  }

  characterMotionIdentity(target: string): string | null {
    const pending = this.pendingCharacterPlacements.get(target);
    const identity = this.characterControllerIdentities.get(target);
    if (pending && identity === pending.identity && this.characterLoadTokens.get(target) === pending.token) {
      return identity;
    }
    if (identity && this.cachedCharacterControllers.has(identity)) return identity;
    return null;
  }

  /** Browser equivalent of AdvEpisodeResourceLoader.TryGetCharacterController. */
  hasCharacterController(target: string): boolean {
    const identity = this.characterControllerIdentities.get(target);
    const pending = this.pendingCharacterPlacements.get(target);
    return Boolean(
      this.cachedCharacterController(target) ||
      (identity && pending?.identity === identity && this.characterLoadTokens.get(target) === pending.token),
    );
  }

  isCharacterShowing(target: string, expectedIdentity?: string): boolean {
    const identity = this.characterMotionIdentity(target);
    const pending = this.pendingCharacterPlacements.get(target);
    const pendingShowing = Boolean(
      pending &&
      identity === pending.identity &&
      this.characterLoadTokens.get(target) === pending.token &&
      (!expectedIdentity || pending.identity === expectedIdentity),
    );
    const selectedController = this.cachedCharacterControllerByIdentity(identity || undefined);
    return Boolean(
      pendingShowing ||
      (selectedController &&
        this.characterItems.get(target) === selectedController &&
        (!expectedIdentity || identity === expectedIdentity)),
    );
  }

  /** Reapply host playback speed to every character provider controller. */
  setPlaybackSpeed(rate: number): void {
    const next = Math.max(0.001, finite(rate, 1));
    if (Math.abs(next - this.playbackSpeedRate) > 0.000001) {
      this.playbackSpeedEvents.push({ rate: next, queuedAtSeconds: this.monotonicSeconds() });
    }
    this.playbackSpeedRate = next;
    this.overlay?.canvasPass.setStillSpeed(next);
    const controllers = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const { item } of this.stagedCharacterItems.values()) controllers.add(item);
    for (const item of controllers) {
      this.invokeCharacterModel(item, "set playback speed", undefined, (model) =>
        model.setMotionSpeed(this.playbackSpeedRate),
      );
    }
  }

  async setBackground(
    background: AdvBackgroundEntry | null | undefined,
    _transitionDuration = 0,
    stageCaptureOwner?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Compilation replays thousands of stage swaps; loading each texture
    // here burned VRAM on backgrounds the player never sees.
    if (this.seekIndexCompilationActive) {
      this.state.background = background ?? null;
      return true;
    }
    const ownsCapture = (): boolean =>
      !signal?.aborted && (stageCaptureOwner == null || stageCaptureOwner === this.stageCaptureGeneration);
    if (!ownsCapture()) return false;
    const epoch = ++this.frameEpoch;
    const url = firstString(background?.url);
    if (!url) {
      this.backgroundMesh?.removeFromParent();
      this.backgroundMesh?.material.dispose();
      this.backgroundMesh = null;
      this.backgroundCaptureMesh?.removeFromParent();
      this.backgroundCaptureMesh?.material.dispose();
      this.backgroundCaptureMesh = null;
      this.backgroundTextureLease?.release();
      this.backgroundTextureLease = null;
      const hasStage = background?.stage != null;
      this.backgroundField.visible = hasStage;
      this.backgroundCaptureField.visible = hasStage;
      if (hasStage) this.applyStage(background.stage, 0, true);
      this.state.background = hasStage ? background : null;
      return true;
    }
    const textureLease = await this.acquireTexture(url, signal);
    if (epoch !== this.frameEpoch || this.destroyed || !ownsCapture()) {
      textureLease.release();
      return false;
    }
    const texture = textureLease.value;
    const material = new MeshBasicMaterial({
      map: texture,
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const next = new Mesh(this.backgroundGeometry, material);
    next.name = "AdvBackgroundSprite";
    const nextCapture = new Mesh(this.backgroundGeometry, material.clone());
    nextCapture.name = "AdvBackgroundCaptureSprite";
    const stage = record(background?.stage);
    const sprite = record(stage.backgroundSprite);
    const size = record(stage.backgroundSize || sprite.worldSize || this.runtime.stage.backgroundSize);
    const fieldScale = finite(stage.backgroundFieldScale, finite(record(this.runtime.stage).backgroundFieldScale, 1));
    const fit = String(stage.backgroundFit || this.runtime.stage.backgroundFit || "authored");
    let width = finite(size.width, this.runtime.stage.backgroundSize.width);
    let height = finite(size.height, this.runtime.stage.backgroundSize.height);
    let appliedFieldScale = fieldScale;
    if (fit === "camera-width" || fit === "cover" || fit === "contain") {
      const cameraPosition = vec3(stage.initialCameraPosition ?? this.runtime.stage.initialCameraPosition, ZERO_VEC3);
      const backgroundPosition = vec3(
        stage.backgroundFieldPosition ?? this.runtime.stage.backgroundFieldPosition,
        BACKGROUND_FIELD_POSITION,
      );
      const depth = Math.max(0.001, backgroundPosition.z - cameraPosition.z);
      const fov = Math.max(1, finite(stage.fov, finite(this.runtime.stage.fov, 39.6)));
      const visibleHeight = 2 * depth * Math.tan((fov * Math.PI) / 360);
      const visibleWidth = visibleHeight * Math.max(0.001, this.camera.aspect);
      const aspect = textureAspect(texture, this.camera.aspect);
      width =
        fit === "cover"
          ? Math.max(visibleWidth, visibleHeight * aspect)
          : fit === "contain"
            ? Math.min(visibleWidth, visibleHeight * aspect)
            : visibleWidth;
      width *= Math.max(1, finite(stage.backgroundOverscan, finite(this.runtime.stage.backgroundOverscan, 1)));
      height = width / aspect;
      // Camera-fit dimensions are already world units. Field scale remains an
      // authored-stage concern and must not be multiplied in a second time.
      appliedFieldScale = 1;
    }
    const pivot = record(sprite.pivot);
    const scaledWidth = width * appliedFieldScale;
    const scaledHeight = height * appliedFieldScale;
    next.scale.set(scaledWidth, scaledHeight, appliedFieldScale);
    // Unity Sprite vertices are relative to the serialized pivot. Current
    // reference sprites are centered, but retaining this offset makes future
    // non-centred sprites use the same local geometry without a processor-specific case.
    next.position.set((0.5 - finite(pivot.x, 0.5)) * scaledWidth, (0.5 - finite(pivot.y, 0.5)) * scaledHeight, 0);
    nextCapture.scale.copy(next.scale);
    nextCapture.position.copy(next.position);
    const previous = this.backgroundMesh;
    const previousCapture = this.backgroundCaptureMesh;
    const previousTextureLease = this.backgroundTextureLease;
    this.backgroundMesh = next;
    this.backgroundCaptureMesh = nextCapture;
    this.backgroundTextureLease = textureLease;
    this.backgroundField.add(next);
    this.backgroundCaptureField.add(nextCapture);
    this.backgroundField.visible = true;
    this.backgroundCaptureField.visible = true;
    this.applyStage(stage, 0, true);
    this.state.background = background;
    if (previous && previous !== next) {
      previousCapture?.removeFromParent();
      previous.removeFromParent();
      previous.material.dispose();
      previousCapture?.material.dispose();
    }
    previousTextureLease?.release();
    return true;
  }

  captureStage(signal?: AbortSignal): Promise<number | null> {
    if (this.destroyed || !this.pipeline || signal?.aborted) return Promise.resolve(null);
    this.cancelPendingStageCapture(false);
    const generation = ++this.stageCaptureGeneration;
    return new Promise<number | null>((resolve) => {
      const onAbort = (): void => {
        if (this.pendingStageCapture?.generation !== generation) return;
        this.cancelPendingStageCapture(true);
      };
      const resolveCapture = (owner: number | null): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(owner);
      };
      this.pendingStageCapture = { generation, resolve: resolveCapture };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async fadeStageCapture(duration: number, owner: number, signal?: AbortSignal): Promise<boolean> {
    if (owner !== this.stageCaptureGeneration) return false;
    const from = this.stageCaptureAlpha;
    await this.runTween({
      duration,
      signal,
      ease: resolveEase(6),
      update: (progress) => {
        if (owner === this.stageCaptureGeneration) this.stageCaptureAlpha = lerp(from, 0, progress);
      },
    });
    if (owner !== this.stageCaptureGeneration) return false;
    if (signal?.aborted) return false;
    this.resetStageCapture(owner);
    return true;
  }

  private cancelPendingStageCapture(clearComposite: boolean): void {
    const pending = this.pendingStageCapture;
    if (pending) {
      this.pendingStageCapture = null;
      this.stageCaptureGeneration += 1;
      pending.resolve(null);
    }
    if (clearComposite) this.stageCaptureAlpha = 0;
  }

  resetStageCapture(owner?: number): void {
    if (owner != null && owner !== this.stageCaptureGeneration) return;
    this.stageCaptureGeneration += 1;
    this.stageCaptureAlpha = 0;
    this.pendingStageCapture?.resolve(null);
    this.pendingStageCapture = null;
  }

  private applyStage(stageValue: unknown, focusGroupIndex = 0, reset = true): void {
    const stage = record(stageValue);
    this.state.stage = stageValue || null;
    const stageUpdate = { ...this.runtime.stage } as AdvRuntimeConfig["stage"] & UnknownRecord;
    for (const key of [
      "screenReferenceWidth",
      "screenReferenceHeight",
      "initialCameraPosition",
      "initialCameraRotation",
      "characterFieldPosition",
      "backgroundFieldPosition",
      "characterFieldScale",
      "backgroundFieldScale",
      "characterPixelsPerUnit",
      "characterCanvasWorldHeight",
      "backgroundFit",
      "backgroundOverscan",
      "fov",
    ]) {
      if (stage[key] != null) stageUpdate[key] = stage[key];
    }
    const backgroundSprite = record(stage.backgroundSprite);
    if (stage.backgroundSize || backgroundSprite.worldSize) {
      stageUpdate.backgroundSize = (stage.backgroundSize || backgroundSprite.worldSize) as {
        width: number;
        height: number;
      };
    }
    const groups = Array.isArray(stage.focusPointGroups) ? stage.focusPointGroups : [];
    const points = (groups[Math.max(0, focusGroupIndex)] || groups[0]) as unknown;
    if (Array.isArray(points) && points.length >= 9) {
      const anchors: Record<number, Vec3> = {};
      for (let pointIndex = 0; pointIndex < 9; pointIndex += 1) {
        anchors[pointIndex + 1] = vec3(points[pointIndex], { x: 0, y: 0, z: 0 });
      }
      stageUpdate.focusAnchors = anchors;
      stageUpdate.positions = { 1: anchors[1], 3: anchors[3], 5: anchors[5], 7: anchors[7], 9: anchors[9] };
      stageUpdate.minX = Math.min(...Object.values(anchors).map((point) => point.x));
      stageUpdate.maxX = Math.max(...Object.values(anchors).map((point) => point.x));
      stageUpdate.width = stageUpdate.maxX - stageUpdate.minX;
    }
    this.runtime = { ...this.runtime, stage: stageUpdate };
    this.focusDataSettingsKey = String(stage.usingFocusDataSettingsKey || this.focusDataSettingsKey);
    if (!reset) {
      this.applyTransforms();
      return;
    }
    this.stageOffsets.clear();
    const initialPosition = vec3(stage.initialCameraPosition ?? this.runtime.stage.initialCameraPosition, ZERO_VEC3);
    const initialRotation = vec3(stage.initialCameraRotation ?? this.runtime.stage.initialCameraRotation, ZERO_VEC3);
    const positionMagnitude = initialPosition.x ** 2 + initialPosition.y ** 2 + initialPosition.z ** 2;
    const rotationMagnitude = initialRotation.x ** 2 + initialRotation.y ** 2 + initialRotation.z ** 2;
    if (positionMagnitude >= 9.99999944e-11) {
      this.cameraState.baseX = initialPosition.x;
      this.cameraState.baseY = initialPosition.y;
      this.cameraState.baseZ = initialPosition.z;
    } else {
      this.cameraState.baseX = 0;
      this.cameraState.baseY = 0;
      this.cameraState.baseZ = 0;
    }
    if (rotationMagnitude >= 9.99999944e-11) {
      // AdvStage.get_InitialCameraRotation negates X only.
      this.cameraState.rotationX = -initialRotation.x;
      this.cameraState.rotationY = initialRotation.y;
      this.cameraState.angle = initialRotation.z;
    } else {
      this.cameraState.rotationX = 0;
      this.cameraState.rotationY = 0;
      this.cameraState.angle = 0;
    }
    this.cameraState.fieldRotationY = 0;
    this.cameraState.stageRotationY = 0;
    this.cameraState.zoomRatio = 1;
    this.cameraState.panOffsetX = 0;
    this.cameraState.panOffsetY = 0;
    this.cameraState.focusPositionType = 5;
    this.cameraState.focusTargetName = "";
    this.applyStageMultiplyTexture(stage);
    this.applyStageLight(0);
    this.applyStagePostEffect(0);
    this.changeStageParticleEffects(0);
    this.applyTransforms();
  }

  applyStageEnv(index = 0): void {
    const stage = record(this.state.stage);
    const groups = Array.isArray(stage.focusPointGroups) ? stage.focusPointGroups : [];
    const requestedIndex = Math.trunc(finite(index));
    const resolvedIndex =
      requestedIndex >= 0 && requestedIndex < groups.length && groups[requestedIndex] != null ? requestedIndex : 0;
    this.stageOffsets.clear();
    this.applyStage(this.state.stage, resolvedIndex, false);
  }

  private environmentPostEffect(index = 0): UnknownRecord | null {
    const stage = record(this.state.stage);
    const profiles = stage.environmentPostEffects || stage.environmentPosteffects;
    const requestedIndex = Math.trunc(finite(index));
    if (Array.isArray(profiles)) {
      if (requestedIndex < 0 || requestedIndex >= profiles.length) return null;
      const profile = record(profiles[requestedIndex]);
      return Object.keys(profile).length ? profile : null;
    }
    if (requestedIndex !== 0) return null;
    const profile = record(stage.environmentPostEffect);
    return Object.keys(profile).length ? profile : null;
  }

  private environmentLightGroup(index = 0): UnknownRecord | null {
    const stage = record(this.state.stage);
    const groups = stage.environmentLightGroups || stage.environmentLightgroups;
    const requestedIndex = Math.trunc(finite(index));
    if (Array.isArray(groups)) {
      if (requestedIndex < 0 || requestedIndex >= groups.length) return null;
      const group = record(groups[requestedIndex]);
      return Object.keys(group).length ? group : null;
    }
    if (requestedIndex !== 0) return null;
    const group = record(stage.environmentLightGroup);
    return Object.keys(group).length ? group : null;
  }

  applyStageLight(index = 0): void {
    const group = this.environmentLightGroup(index);
    const lights = (Array.isArray(group?.lights) ? group.lights : [])
      .map(record)
      .filter((light) => light.active !== false);
    const directional = lights.find(
      (light) => Number(light.type) === 1 || String(light.typeName || "").toLowerCase() === "directional",
    );
    const lightQuaternion = (value: unknown) => {
      const source = record(value);
      return {
        x: finite(source.x),
        y: finite(source.y),
        z: finite(source.z),
        w: finite(source.w, 1),
      };
    };
    const lightColor = (value: unknown) => {
      const source = record(value);
      return { r: finite(source.r, 1), g: finite(source.g, 1), b: finite(source.b, 1) };
    };
    const main = packUnityUrpDirectionalLight(
      directional
        ? {
            active: true,
            forward: vec3(directional.worldForward, { x: 0, y: 0, z: 1 }),
            rotation: lightQuaternion(directional.worldRotation),
            color: lightColor(directional.color),
            intensity: finite(directional.intensity, 1),
          }
        : null,
    );
    const additional = packUnityUrpAdditionalLights(
      lights
        .filter((light) => light !== directional)
        .map((light): UnityCharacterAdditionalLightLike => ({
          active: true,
          type: finite(light.type, -1),
          position: vec3(light.worldPosition, { x: 0, y: 0, z: 0 }),
          forward: vec3(light.worldForward, { x: 0, y: 0, z: 1 }),
          rotation: lightQuaternion(light.worldRotation),
          color: lightColor(light.color),
          intensity: finite(light.intensity, 1),
          range: finite(light.range, 10),
          spotAngle: finite(light.spotAngle, 30),
          innerSpotAngle: Number.isFinite(Number(light.innerSpotAngle)) ? Number(light.innerSpotAngle) : undefined,
        })),
    );
    const enabled = this.qualityConfig.isUnityLightingEnabled() && lights.length > 0;
    this.characterLightingState = {
      enabled,
      disableForMultiplicativeDrawables: true,
      mainLightPosition: main.mainLightPosition,
      mainLightColor: main.mainLightColor,
      sphericalHarmonics: UNITY_CHARACTER_REFERENCE_FLAT_WHITE_SH,
      additionalLights: enabled ? additional : [],
    };
    const controllers = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const { item } of this.stagedCharacterItems.values()) controllers.add(item);
    for (const item of controllers) {
      this.invokeCharacterModel(item, "apply stage lighting", undefined, (model) =>
        model.setRendererLighting?.(this.characterLightingState),
      );
    }
    const sourceColor = record(directional?.color);
    const intensity = finite(directional?.intensity, 1);
    this.stageLightState = {
      index: Math.trunc(finite(index)),
      group,
      enabled,
      color: directional
        ? {
            r: finite(sourceColor.r, 1) * intensity,
            g: finite(sourceColor.g, 1) * intensity,
            b: finite(sourceColor.b, 1) * intensity,
          }
        : { r: 1, g: 1, b: 1 },
      source: directional || null,
      lighting: this.characterLightingState,
    };
    this.state.stageLight = this.stageLightState;
  }

  private applyStageMultiplyTexture(stage: UnknownRecord): void {
    const texture = record(stage.shadowTexture || stage.multiplyTexture);
    this.stageMultiplyTextureUrl = firstString(texture.url, stage.shadowTextureUrl, stage.multiplyTextureUrl);
    const uv = record(stage.shadowTextureUv || stage.multiplyTextureUv);
    const amplitude = record(stage.shadowTextureAmplitude || stage.multiplyTextureAmplitude);
    this.stageMultiplyTextureOptions = {
      enabled: Boolean(this.stageMultiplyTextureUrl),
      uv: [finite(uv.x, 1), finite(uv.y, 1), finite(uv.z), finite(uv.w)],
      intensity: finite(stage.shadowTextureIntensity ?? stage.multiplyTextureIntensity, 0.3),
      amplitude: [finite(amplitude.x, 0.002), finite(amplitude.y, 0.002)],
      frequency: finite(stage.shadowTextureFrequency ?? stage.multiplyTextureFrequency, 0.5),
    };
    const version = ++this.stageMultiplyTextureVersion;
    const controllers = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const { item } of this.stagedCharacterItems.values()) controllers.add(item);
    for (const item of controllers) {
      void this.invokeCharacterModelTask(item, "apply stage multiply texture", undefined, (model) =>
        this.configureModelMultiplyTexture(model, version),
      );
    }
  }

  private async configureModelMultiplyTexture(model: ThreeStoryCharacterModel, version: number): Promise<void> {
    const url = this.stageMultiplyTextureUrl;
    const options = this.stageMultiplyTextureOptions;
    if (!url) {
      model.clearRendererMultiplyTexture?.();
      return;
    }
    if (!model.loadRendererMultiplyTexture) return;
    await model.loadRendererMultiplyTexture(url, options);
    // A stage can change while its image is decoding. Re-apply the latest
    // authored state instead of letting the older async load win the race.
    if (version !== this.stageMultiplyTextureVersion) {
      await this.configureModelMultiplyTexture(model, this.stageMultiplyTextureVersion);
    }
  }

  applyStagePostEffect(index = 0): void {
    this.stagePostEffect = this.qualityConfig.isStagePostEffectEnabled() ? this.environmentPostEffect(index) : null;
    this.state.stagePostEffect = this.stagePostEffect;
    this.syncPostPipeline();
  }

  changeStageParticleEffects(index = 0): void {
    const stage = record(this.state.stage);
    const groups = Array.isArray(stage.particleEffectGroups)
      ? stage.particleEffectGroups
      : Array.isArray(stage.particleEffects)
        ? stage.particleEffects
        : [];
    for (const key of this.stageParticleKeys) this.stageEffects.stop(key);
    this.stageParticleKeys.clear();
    const requestedIndex = Math.trunc(finite(index));
    const selected =
      this.qualityConfig.isStageParticleEffectEnabled() && requestedIndex >= 0 && requestedIndex < groups.length
        ? (groups[requestedIndex] ?? null)
        : null;
    this.state.stageParticleEffects = selected;
    const effects = Array.isArray(record(selected).effects) ? (record(selected).effects as unknown[]) : [];
    effects.forEach((rawEffect, effectIndex) => {
      const effect = record(rawEffect);
      const runtime = effect.runtime as AdvEffectEntry["runtime"];
      if (!runtime) return;
      const key = `stage:${requestedIndex}:${effectIndex}`;
      this.stageParticleKeys.add(key);
      void this.stageEffects
        .play(key, runtime as unknown as UnityEffectRuntimeDefinition, {
          simulationSpeed: 1,
          anchor: this.characterField,
        })
        .catch((error) => {
          if (!this.state.error) this.state.error = error instanceof Error ? error.message : String(error);
        });
    });
  }

  private stillKey(still: AdvStillEntry): string {
    return String(still.assetName || still.sourcePath || still.url || "");
  }

  private async fadeStillLayer(key: string, alpha: number, duration: number, operation: number): Promise<void> {
    const pass = this.overlay?.canvasPass,
      from = pass?.stillOpacity(key) || 0;
    await this.runTween({
      duration,
      ease: resolveEase(6),
      update: (progress) => {
        if (this.stillOperations.get(key) === operation) pass?.setStillOpacity(key, lerp(from, clamp(alpha), progress));
      },
    });
  }

  async setStill(still: AdvStillEntry | null | undefined, alpha = 1, duration = 0): Promise<void> {
    const generation = ++this.stillGeneration,
      pass = this.overlay?.canvasPass;
    this.stillOperations.clear();
    if (!pass) return;
    if (!still?.url) {
      await this.fadeStill(0, duration);
      if (generation !== this.stillGeneration || this.destroyed) return;
      pass.clearStills();
      await this.overlay?.setStill("", 0);
      this.overlay?.setStillViewAlpha(0, 0);
      this.state.still = null;
      return;
    }
    pass.clearStills();
    const key = this.stillKey(still),
      operation = ++this.stillOperationSerial;
    this.stillOperations.set(key, operation);
    const presentation = this.context.rendererExtensions?.service(STORY_STILL_PRESENTATION_PROVIDER)?.resolve(still);
    await pass.showStill(key, still, duration > 0 ? 0 : alpha, presentation, 0);
    if (generation !== this.stillGeneration || this.destroyed) return;
    await this.fadeStillLayer(key, alpha, duration, operation);
    if (generation !== this.stillGeneration || this.destroyed) return;
    this.overlay?.setStillViewAlpha(1, 0);
    this.state.still = pass.topStill;
  }

  async runStillCommand(
    still: AdvStillEntry | null | undefined,
    stillAlpha: number,
    overlayAlpha: number,
    animationIndex: number,
    duration = 0,
  ): Promise<void> {
    const pass = this.overlay?.canvasPass;
    if (!still?.url || !pass) return;
    const generation = ++this.stillGeneration;
    const key = this.stillKey(still),
      operation = ++this.stillOperationSerial;
    this.stillOperations.set(key, operation);
    const owns = () => !this.destroyed && this.stillOperations.get(key) === operation;
    const seconds = Math.max(0, finite(duration));
    if (pass.isStillVisible(key)) {
      await Promise.all([
        this.fadeStillLayer(key, 0, seconds, operation),
        this.fadeStillView(0, 0, seconds, generation),
      ]);
      if (owns()) {
        pass.hideStill(key);
        this.state.still = pass.topStill;
      }
      return;
    }
    const presentation = this.context.rendererExtensions?.service(STORY_STILL_PRESENTATION_PROVIDER)?.resolve(still);
    await pass.showStill(key, still, seconds > 0 ? 0 : clamp(stillAlpha), presentation, animationIndex);
    if (!owns()) return;
    this.overlay?.setStillAnimationIndex(animationIndex);
    this.state.still = pass.topStill;
    const shade = clamp(overlayAlpha);
    await Promise.all([
      this.fadeStillLayer(key, clamp(stillAlpha), seconds, operation),
      this.fadeStillView(shade === 0 ? 1 : null, shade, seconds, generation),
    ]);
  }

  private async fadeStillView(
    backgroundAlpha: number | null,
    overlayAlpha: number,
    duration: number,
    generation = this.stillGeneration,
  ): Promise<void> {
    const fromBackground = this.overlay?.stillBackgroundAlpha || 0;
    const fromOverlay = this.overlay?.stillOverlayAlpha || 0;
    const targetBackground = backgroundAlpha == null ? fromBackground : clamp(backgroundAlpha);
    await this.runTween({
      duration,
      ease: resolveEase(6),
      update: (progress) => {
        if (generation === this.stillGeneration)
          this.overlay?.setStillViewAlpha(
            lerp(fromBackground, targetBackground, progress),
            lerp(fromOverlay, clamp(overlayAlpha), progress),
          );
      },
    });
  }

  async fadeStill(alpha: number, duration = 0): Promise<void> {
    const generation = this.stillGeneration;
    const pass = this.overlay?.canvasPass;
    const values = pass?.visibleStillKeys.map((key) => [key, pass.stillOpacity(key)] as const) ?? [];
    await this.runTween({
      duration,
      ease: resolveEase(6),
      update: (progress) => {
        if (generation === this.stillGeneration)
          for (const [key, from] of values) pass?.setStillOpacity(key, lerp(from, clamp(alpha), progress));
      },
    });
  }

  async clearStill(duration = 0): Promise<void> {
    await this.setStill(null, 0, duration);
  }

  async setFrameOverlay(frame: AdvFrameEntry, alpha = 1, key = ""): Promise<void> {
    const resolvedKey = key || String(frame.name || frame.source || "frame");
    await this.overlay?.setFrame(resolvedKey, frame, alpha);
  }

  setFrameOpacity(alpha: number, slide = 0, key = ""): void {
    const resolvedKey = key || this.state.frameName || "frame";
    this.overlay?.setFrameOpacity(resolvedKey, alpha, slide);
  }

  clearFrameOverlay(key?: string): void {
    this.overlay?.clearFrame(key);
  }

  setCover(color: unknown, opacity: unknown): void {
    // A plain fade and a rule fade are mutually exclusive in UIAdvWidget.
    this.clearRuleTransition();
    const value =
      typeof color === "string"
        ? color
        : `#${(Math.trunc(finite(color)) >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
    this.overlay?.setCover(value, clamp(opacity));
    this.state.cover.color = value;
    this.state.cover.opacity = clamp(opacity);
  }

  async flashWhite(duration = 0.12): Promise<void> {
    this.overlay?.setFlash(1);
    await this.runTween({ duration, update: (progress) => this.overlay?.setFlash(1 - progress) });
    this.overlay?.setFlash(0);
  }

  async runRuleTransition(
    rule: AdvRuleTransitionEntry,
    color: string,
    duration: number,
    fadeOut: boolean,
  ): Promise<void> {
    const source = firstString(rule.texture, rule.maskTexture);
    if (!source) return;
    const version = ++this.ruleTransitionVersion;
    const textureLease = await this.acquireTexture(source);
    if (this.destroyed || version !== this.ruleTransitionVersion) {
      textureLease.release();
      return;
    }
    const resolvedColor = colorComponents(color);
    // Screen-space UI/Transition owns coverage while it is active. Clear a
    // preceding plain Image fade without routing the rule through the DOM.
    this.overlay?.setCover(color, 0);
    const previousTextureLease = this.ruleTransitionTextureLease;
    this.ruleTransitionTextureLease = textureLease;
    const completion = this.ruleTransition.play({
      texture: textureLease.value,
      color: resolvedColor,
      duration,
      curve: rule.easingCurve,
      useGradient: Boolean(rule.gradient),
      fadeOut,
    });
    previousTextureLease?.release();
    await completion;
    if (!fadeOut && this.ruleTransitionTextureLease === textureLease) {
      this.ruleTransitionTextureLease = null;
      textureLease.release();
    }
    if (this.destroyed || version !== this.ruleTransitionVersion) return;
    this.state.cover.color = color;
    this.state.cover.opacity = fadeOut ? 1 : 0;
  }

  private clearRuleTransition(): void {
    this.ruleTransitionVersion += 1;
    this.ruleTransition.clear();
    this.ruleTransitionTextureLease?.release();
    this.ruleTransitionTextureLease = null;
  }

  setVideoLayout(layout?: import("@haneoka/vega/renderer-kit").StoryVideoLayout): void {
    this.state.video.layout = layout;
    this.overlay?.canvasPass.setVideoLayout(layout);
  }

  async showVideo(
    videoInfo: AdvVideoEntry | string,
    fadeIn = 0,
    _readyTimeout = 0,
    playbackRate = 1,
    signal?: AbortSignal,
    targetAlpha = 1,
  ): Promise<void> {
    const generation = this.sceneGeneration;
    const overlay = this.overlay;
    const source =
      typeof videoInfo === "string" ? videoInfo : firstString(videoInfo.playableUrl, videoInfo.src, videoInfo.url);
    overlay?.canvasPass.setVideoLayout(this.state.video.layout);
    const renderable = source ? await this.resolveEpisodeVideoRenderable(source, signal) : undefined;
    const video = await overlay?.showVideo(videoInfo, playbackRate, signal, renderable?.url);
    if (this.destroyed || generation !== this.sceneGeneration || signal?.aborted || this.overlay !== overlay) return;
    if (!video) return;
    Object.assign(this.state.video, {
      visible: true,
      src: source,
      alpha: fadeIn > 0 ? 0 : clamp(targetAlpha),
      playbackRate,
      playing: true,
      ended: false,
    });
    this.overlay?.setVideoAlpha(fadeIn > 0 ? 0 : clamp(targetAlpha));
    if (fadeIn > 0) {
      await this.fadeVideo(targetAlpha, fadeIn);
      if (this.destroyed || generation !== this.sceneGeneration || signal?.aborted || this.overlay !== overlay) return;
    }
  }

  async fadeVideo(alpha: number, duration = 0): Promise<void> {
    const from = finite(this.state.video.alpha, 1);
    const to = clamp(alpha);
    await this.runTween({
      duration,
      ease: resolveEase(6),
      update: (progress) => {
        const value = lerp(from, to, progress);
        this.state.video.alpha = value;
        this.overlay?.setVideoAlpha(value);
      },
    });
  }

  async hideVideo(fadeOut = 0): Promise<void> {
    if (fadeOut > 0) await this.fadeVideo(0, fadeOut);
    this.overlay?.clearVideo();
    Object.assign(this.state.video, {
      visible: false,
      src: "",
      alpha: 1,
      playing: false,
      ended: false,
      currentTime: 0,
      duration: 0,
      progress: 0,
    });
  }

  skipVideo(): boolean {
    const video = this.overlay?.videoElement;
    if (!video) return false;
    video.currentTime = Number.isFinite(video.duration) ? video.duration : video.currentTime;
    return true;
  }

  seekVideoRatio(ratio: unknown): boolean {
    const video = this.overlay?.videoElement;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return false;
    video.currentTime = clamp(ratio) * video.duration;
    return true;
  }

  waitVideoEnded(signal?: AbortSignal): Promise<void> {
    return this.overlay?.waitVideoEnded(signal) || Promise.resolve();
  }

  async setCommandPostEffect(profile: AdvPostEffectEntry | string | unknown, fade = 0): Promise<void> {
    const volumeProfile =
      typeof profile === "string"
        ? ({ name: profile, effectName: profile } satisfies UnityVolumeProfile)
        : (profile as UnityVolumeProfile | null);
    const key = advVolumeProfileKey(volumeProfile);
    if (!key || !volumeProfile) {
      await this.clearCommandPostEffects(fade);
      return;
    }

    let child = this.commandVolumes.get(key);
    if (!child) {
      child = { profile: volumeProfile, weight: 0, enabled: false, version: 0 };
      this.commandVolumes.set(key, child);
    } else {
      child.profile = volumeProfile;
    }
    const target = child.enabled ? 0 : 1;
    child.enabled = target > 0;
    const from = child.weight;
    const version = ++child.version;
    this.commandPostEffect = target > 0 ? volumeProfile : null;
    this.state.commandPostEffect = this.commandPostEffect;
    await this.runTween({
      duration: fade,
      // DOTween.To uses DOTween's default Ease.OutQuad in AdvChildVolume.
      ease: resolveEase(6),
      update: (progress) => {
        if (child?.version !== version) return;
        child.weight = lerp(from, target, progress);
        this.syncPostVolumeLayers();
      },
    });
    if (child.version === version) child.weight = target;
    this.syncPostVolumeLayers();
  }

  async clearCommandPostEffects(fade = 0): Promise<void> {
    const transitions = [...this.commandVolumes.values()].map(async (child) => {
      const from = child.weight;
      const version = ++child.version;
      child.enabled = false;
      await this.runTween({
        duration: fade,
        ease: resolveEase(6),
        update: (progress) => {
          if (child.version !== version) return;
          child.weight = lerp(from, 0, progress);
          this.syncPostVolumeLayers();
        },
      });
      if (child.version === version) child.weight = 0;
    });
    await Promise.all(transitions);
    this.commandPostEffect = null;
    this.state.commandPostEffect = null;
    this.syncPostVolumeLayers();
  }

  private syncPostPipeline(): void {
    this.syncFieldPostEffects();
    this.syncPostVolumeLayers();
  }

  private syncFieldPostEffects(): void {
    if (!this.pipeline) return;
    const lens = record(this.stagePostEffect?.curvedLens);
    const lensAttenuates = lens.attenuateByCameraDistance !== false;
    const lensIntensity = finite(lens.intensity) * (lensAttenuates ? this.fieldRendererState.curvedLensRate : 1);
    const backgroundBlur = this.fieldRendererState.backgroundBlur;
    this.pipeline.setEffects({
      blur: {
        enabled: backgroundBlur > 0.01,
        background: backgroundBlur,
        radiusMax: this.fieldRendererState.blurRadiusMax,
      },
      curvedLens: {
        enabled:
          lens.active !== false &&
          lensIntensity > 0 &&
          (finite(lens.horizontalRate) > 0 || finite(lens.verticalRate) > 0),
        center: { x: finite(record(lens.center).x, 0.5), y: finite(record(lens.center).y, 0.5) },
        intensity: lensIntensity,
        size: finite(lens.size, 0.35),
        softness: finite(lens.softness, 0.2),
        horizontalRate: finite(lens.horizontalRate, 1),
        verticalRate: finite(lens.verticalRate, 0.15),
        scale: finite(lens.scale, 1),
        reverse: lens.reverse !== false,
      },
    });
  }

  private syncPostVolumeLayers(): void {
    if (!this.pipeline) return;
    const volumeLayers: AdvVolumeLayer[] = [];
    if (this.stagePostEffect) {
      volumeLayers.push({ profile: this.stagePostEffect as UnityVolumeProfile, weight: 1 });
    }
    for (const child of this.commandVolumes.values()) {
      if (child.weight > 0) volumeLayers.push({ profile: child.profile, weight: child.weight });
    }
    this.pipeline.setVolumeLayers(volumeLayers);
  }

  private effectContribution(effect: AdvEffectEntry): StoryRendererEffectContribution | null {
    const runtime = record(effect.runtime);
    const effectType = firstString(effect.effectType, runtime.effectType);
    if (!effectType) return null;
    const contribution = this.context.rendererExtensions?.effects.find(
      (candidate) => candidate.effectType === effectType,
    );
    if (!contribution) {
      throw new Error(`No renderer effect plugin is registered for effect type ${effectType}`);
    }
    return contribution;
  }

  private trackRendererEffectOperation(operation: Promise<void>): Promise<void> {
    const settled = operation.catch(() => undefined);
    this.pendingRendererEffectOperations.add(settled);
    void settled.then(() => {
      this.pendingRendererEffectOperations.delete(settled);
    });
    return operation;
  }

  private async disposeRendererEffectResource(
    instance: RendererExtensionEffectInstance,
    reason: string,
  ): Promise<void> {
    if (instance.resourceDisposed || !instance.resource) return;
    instance.resourceDisposed = true;
    const resource = instance.resource;
    instance.resource = null;
    try {
      await disposeVegaDisposable(resource);
    } catch (error) {
      console.warn(`[ThreeStoryScene] renderer effect ${instance.key} disposal failed during ${reason}`, error);
    }
  }

  private stopRendererExtensionEffect(key: string, reason: string): void {
    const instance = this.rendererExtensionEffects.get(key);
    if (!instance) return;
    this.rendererExtensionEffects.delete(key);
    instance.stopRequested = true;
    instance.detach();
    instance.controller.abort();
    if (instance.resource) {
      this.trackRendererEffectOperation(this.disposeRendererEffectResource(instance, reason));
    }
  }

  private stopRendererExtensionEffects(reason: string): void {
    for (const key of [...this.rendererExtensionEffects.keys()]) {
      this.stopRendererExtensionEffect(key, reason);
    }
  }

  private playRendererExtensionEffect(
    contribution: StoryRendererEffectContribution,
    effect: AdvEffectEntry,
    state: CommandEffectState,
    route: AdvEffectRoute,
  ): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) {
      throw new Error(`Renderer effect ${contribution.id} cannot start before scene setup`);
    }
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error("Three renderer effects require WebGL2");
    }
    const targetScene = this.commandEffectScene(route);
    const anchor =
      route.phase === "advBack"
        ? this.backgroundField
        : route.phase === "character"
          ? this.stageNode(route.positionType ?? 5)
          : route.phase === "advFront"
            ? this.characterField
            : null;
    const controller = new AbortController();
    const instance: RendererExtensionEffectInstance = {
      key: state.key,
      contribution,
      controller,
      detach: this.bindControllerToSignal(controller, this.lifecycleController.signal),
      resource: null,
      stopRequested: false,
      resourceDisposed: false,
    };
    this.rendererExtensionEffects.set(state.key, instance);
    const rendererContext = this.createRendererContext(renderer, gl, {
      key: state.key,
      route,
      scene: targetScene,
      anchor,
      atOnce: state.atOnce,
      simulationSpeed: state.simulationSpeed,
    });
    const registry = this.context.rendererExtensions;
    if (!registry) {
      this.rendererExtensionEffects.delete(state.key);
      instance.detach();
      controller.abort();
      throw new Error("Renderer effect registry is unavailable");
    }
    const extensionContext: StoryRendererExtensionContext<ThreeRendererId, ThreeRendererContext> = {
      renderer: this.rendererId,
      rendererContext,
      runtime: this.runtime,
      state: this.state,
      resources: this.resources,
      signal: controller.signal,
      service: (key) => registry.service(key),
    };
    const definition =
      effect.runtime && typeof effect.runtime === "object"
        ? effect.runtime
        : (effect as Readonly<Record<string, unknown>>);
    const operation = Promise.resolve()
      .then(() => contribution.create(definition, extensionContext, controller.signal))
      .then(async (resource) => {
        if (!isVegaDisposable(resource)) {
          throw new TypeError(`Renderer effect ${contribution.id} did not return a disposable resource`);
        }
        instance.resource = resource;
        if (
          instance.stopRequested ||
          controller.signal.aborted ||
          this.destroyed ||
          this.rendererExtensionEffects.get(state.key) !== instance
        ) {
          await this.disposeRendererEffectResource(instance, "stale creation");
        }
      })
      .catch((error: unknown) => {
        if (this.rendererExtensionEffects.get(state.key) === instance) {
          this.rendererExtensionEffects.delete(state.key);
          this.commandEffectStates.delete(state.key);
        }
        instance.detach();
        if (instance.stopRequested || controller.signal.aborted || this.destroyed) {
          return;
        }
        throw error;
      });
    return this.trackRendererEffectOperation(operation);
  }

  async playCommandEffect(
    effect: AdvEffectEntry | null,
    options: {
      atOnce?: boolean;
      simulationSpeed?: number;
      positionType?: number;
      targetName?: string;
      canvasLayers?: readonly unknown[];
    } = {},
  ): Promise<void> {
    const key = firstString(options.targetName, effect?.name, "adv-command-effect");
    if (this.commandEffects.isPlaying(key) || this.rendererExtensionEffects.has(key)) {
      this.commandEffects.stop(key, Boolean(options.atOnce));
      this.stopRendererExtensionEffect(key, "command stop");
      this.commandEffectStates.delete(key);
      return;
    }
    if (!effect) return;
    const route = resolveAdvEffectRoute(options.canvasLayers, options.positionType);
    const state: CommandEffectState = {
      key,
      effect,
      atOnce: Boolean(options.atOnce),
      simulationSpeed: Math.max(0, finite(options.simulationSpeed, 1)),
      positionType: options.positionType,
      targetName: key,
      canvasLayers: [...(options.canvasLayers || [])],
    };
    this.commandEffectStates.set(key, state);
    const contribution = this.effectContribution(effect);
    if (contribution) {
      await this.playRendererExtensionEffect(contribution, effect, state, route);
      return;
    }
    if (!effect.runtime) {
      this.commandEffectStates.delete(key);
      throw new Error(`ADV effect ${effect.name || key} has no Unity particle prefab data`);
    }
    const anchor =
      route.phase === "advBack"
        ? this.backgroundField
        : route.phase === "character"
          ? this.stageNode(route.positionType ?? 5)
          : route.phase === "advFront"
            ? this.characterField
            : null;
    await this.commandEffects.play(key, effect.runtime as unknown as UnityEffectRuntimeDefinition, {
      simulationSpeed: state.simulationSpeed,
      anchor,
      sortingOrderOverride: route.sortingOrder,
      targetScene: this.commandEffectScene(route),
    });
  }

  isCommandEffectPlaying(key: string): boolean {
    return this.commandEffects.isPlaying(key) || this.rendererExtensionEffects.has(key);
  }

  stopCommandEffects(): void {
    this.commandEffects.stop();
    this.stopRendererExtensionEffects("command effects stopped");
    this.commandEffectStates.clear();
  }

  async settleSeekSnapshotResources(): Promise<void> {
    await Promise.all([
      this.commandEffects.waitForPending(),
      this.stageEffects.waitForPending(),
      ...this.pendingRendererEffectOperations,
    ]);
  }

  seekSnapshotSafety(): SeekSnapshotSafety {
    if (this.destroyed || !this.renderer) return { safe: false, reason: "scene-not-ready" };
    if (this.contextLost || this.contextRestoreController) return { safe: false, reason: "webgl-context-restoring" };
    if (this.characterModelRecoveryStates.size) return { safe: false, reason: "character-model-recovering" };
    if (this.pendingStageCapture || this.stageCaptureAlpha > 0.000001) {
      return { safe: false, reason: "stage-capture-active" };
    }
    if (this.pendingCharacterCommands.hasPendingLoads) {
      return { safe: false, reason: "character-load-active" };
    }
    if (this.commandEffects.hasPendingEffects || this.stageEffects.hasPendingEffects) {
      return { safe: false, reason: "particle-effect-loading" };
    }
    if (this.pendingRendererEffectOperations.size) {
      return { safe: false, reason: "renderer-effect-loading" };
    }
    if (this.backgroundBlurTweenController) return { safe: false, reason: "background-blur-active" };
    if (this.characterBlurTweenControllers.size || this.characterBrightnessTweenControllers.size) {
      return { safe: false, reason: "character-renderer-tween-active" };
    }
    if (this.state.video.visible || this.overlay?.videoElement) return { safe: false, reason: "video-active" };
    if (
      this.commandShakeControllers.size > 0 ||
      Math.abs(this.backgroundShake.x) > 0.000001 ||
      Math.abs(this.backgroundShake.y) > 0.000001 ||
      Math.abs(this.characterShake.x) > 0.000001 ||
      Math.abs(this.characterShake.y) > 0.000001
    ) {
      return { safe: false, reason: "transient-shake-active" };
    }
    if (this.cameraShakeMode === "stopping") {
      return { safe: false, reason: "camera-shake-stopping" };
    }
    for (const item of new Set(this.cachedCharacterControllers.values())) {
      if (item.angleTweenController) return { safe: false, reason: `character-angle-active:${item.target}` };
      if (item.lookTweenController) return { safe: false, reason: `character-look-active:${item.target}` };
      if (item.lipSync.enabled || item.lipSync.motionSyncPcm || item.lipSync.sources.length) {
        return { safe: false, reason: `character-lip-active:${item.target}` };
      }
    }
    return { safe: true };
  }

  createSeekSnapshot(): AdvStorySceneSeekSnapshot | null {
    if (!this.screenEffects.ready) return null;
    if (this.overlay && !this.overlay.canvasPass.ready) return null;
    if (!this.seekSnapshotSafety().safe) return null;
    const characters = [...this.cachedCharacterControllers.entries()].map(([controllerIdentity, item]) => ({
      target: item.target,
      characterKey: item.characterKey,
      identity: controllerIdentity,
      controllerIdentity,
      visible: this.characterItems.get(item.target) === item,
      speculative: this.speculativeCharacterControllers.get(controllerIdentity) === item,
      entry: item.entry,
      positionType: item.positionType,
      worldPosition: item.worldPosition ? { ...item.worldPosition } : null,
      offset: { ...item.offset },
      ...(item.model.createSnapshot ? { modelState: item.model.createSnapshot() } : {}),
      alpha: item.alpha,
      brightness: item.brightness,
      facing: item.facing,
      roleAngle: item.roleAngle,
      angle: item.angle,
      bodyAngle: item.bodyAngle,
      angleOverride: item.angleOverride,
      lookX: item.lookX,
      lookY: item.lookY,
      lookOriginalX: item.lookOriginalX,
      lookOriginalY: item.lookOriginalY,
      lookOverride: item.lookOverride,
      blurIntensity: item.blurIntensity,
      sortingOrder: item.sortingOrder,
      rimLight: clonePlain(item.rimLight),
      presentation: [
        ...(item.currentMotionName ? [{ kind: "motion" as const, name: item.currentMotionName }] : []),
        ...(item.activeExpressionName ? [{ kind: "expression" as const, name: item.activeExpressionName }] : []),
      ],
      currentMotionName: item.currentMotionName,
      currentMotionFadeInSeconds: item.currentMotionFadeInSeconds,
      currentExpressionName: item.currentExpressionName,
      currentExpressionFadeInSeconds: item.currentExpressionFadeInSeconds,
      activeExpressionName: item.activeExpressionName,
      activeExpressionFadeInSeconds: item.activeExpressionFadeInSeconds,
      pendingPausedMotion: item.pendingPausedMotion ? { ...item.pendingPausedMotion } : null,
      pendingPausedExpression: item.pendingPausedExpression ? { ...item.pendingPausedExpression } : null,
      // Active lip states are rejected by seekSnapshotSafety; retain the
      // normalized idle values without serializing browser audio objects.
      lipSync: {
        ...item.lipSync,
        motionSyncPcm: null,
        sources: [] as const,
        dampVelocity: { ...item.lipSync.dampVelocity },
        randomSeed: { ...item.lipSync.randomSeed },
      },
      paused: item.paused,
    }));
    return {
      version: STORY_SCENE_SEEK_SNAPSHOT_VERSION,
      rendererState: {
        kind: "three",
        version: 3,
        transforms: [...this.sceneTransforms].map(([target, value]) => ({
          target,
          current: { ...value.current },
          planned: { ...value.planned },
        })),
      },
      pluginState: clonePlain(this.state.pluginState),
      ...(this.state.video.layout ? { videoLayout: clonePlain(this.state.video.layout) } : {}),
      background: (this.state.background as AdvBackgroundEntry | null) || null,
      still: (this.state.still as AdvStillEntry | null) || null,
      stillAlpha: this.overlay?.stillAlpha || 0,
      stillBackgroundAlpha: this.overlay?.stillBackgroundAlpha || 0,
      stillOverlayAlpha: this.overlay?.stillOverlayAlpha || 0,
      stillAnimationIndex: this.overlay?.stillAnimationIndex || 0,
      frame: this.state.frame,
      frameName: this.state.frameName,
      frameOpacity: this.state.frameOpacity,
      frameSlide: this.state.frameSlide,
      frameEntries: clonePlain(this.state.frameEntries),
      frameParticles: this.overlay?.snapshotFrameParticles() ?? {},
      stillLayers: this.overlay?.canvasPass.snapshotStills() ?? [],
      stage: this.state.stage,
      screenEffects: this.screenEffects.snapshot(),
      screenFilterState: [...this.screenFilters].map(([target, entry]) => ({
        target,
        state: entry.controller.snapshot(),
      })),
      stageEnv: clonePlain(this.state.stageEnv),
      stageOffsets: [...this.stageOffsets.entries()].map(([key, value]) => [key, { ...value }] as const),
      cameraState: clonePlain(this.cameraState),
      cameraShake: {
        enabled: this.cameraShakeMode === "playing",
        strength: this.cameraShakeStrength,
        cycleSeconds: this.cameraShakeCycleSeconds,
        vibrato: this.cameraShakeVibrato,
        randomness: this.cameraShakeRandomness,
      },
      fieldRendererState: clonePlain(this.fieldRendererState),
      postEffect: clonePlain(this.state.postEffect),
      commandVolumes: [...this.commandVolumes.entries()].map(([key, child]) => ({
        key,
        profile: child.profile,
        weight: child.weight,
        enabled: child.enabled,
      })),
      commandEffects: [...this.commandEffectStates.values()]
        .filter((entry) => this.commandEffects.isPlaying(entry.key))
        .map((entry) => ({
          ...entry,
          canvasLayers: [...entry.canvasLayers],
        })),
      effect: this.state.effect,
      effects: clonePlain(this.state.effects),
      cover: clonePlain(this.state.cover),
      talk: clonePlain(this.state.talk),
      // Story-title visibility is controlled by a Vue timer outside the scene;
      // shortcut seek never replays elapsed UI-only title time.
      title: { ...clonePlain(this.state.title), visible: false },
      location: clonePlain(this.state.location),
      subtitles: clonePlain(this.state.subtitles),
      chat: clonePlain(this.state.chat),
      choices: clonePlain(this.state.choices),
      dofActive: Boolean(this.state.dofActive),
      characters,
      lifecycle: {
        characterLoadSequence: this.characterLoadSequence,
        characterLoadTokens: [...this.characterLoadTokens.entries()],
        characterControllerIdentities: [...this.characterControllerIdentities.entries()],
        pendingCharacters: this.pendingCharacterCommands.createSnapshot(),
        characterPriorityOrder: [...this.characterPriorityOrder],
      },
    };
  }

  async restoreSeekSnapshot(snapshot: PortableAdvStorySceneSeekSnapshot, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.destroyed) return;
    if (snapshot.version !== STORY_SCENE_SEEK_SNAPSHOT_VERSION) {
      throw new Error(`Unsupported ADV scene seek snapshot version: ${String(snapshot.version)}`);
    }
    if (!isDetailedThreeStorySceneSeekSnapshot(snapshot)) {
      throw new Error("Unsupported Three scene checkpoint");
    }
    // A pending browser-side model load has no serializable continuation. Such
    // a checkpoint must never have passed seekSnapshotSafety in the first place.
    if (snapshot.lifecycle.pendingCharacters.loads.length) {
      throw new Error("ADV seek snapshot contains a pending character load");
    }

    // Clear transient offsets first. Persistent CameraShake is restored from
    // its logical enabled/configuration state below and starts a fresh cycle.
    this.resetShakeState();
    this.cancelPendingStageCapture(true);
    this.clearRuleTransition();
    this.commandEffects.dispose();
    this.stageEffects.dispose();
    this.commandEffectStates.clear();
    this.stageParticleKeys.clear();
    await this.hideVideo(0);
    if (signal?.aborted || this.destroyed) return;
    this.prepareCharactersForSeekRestore();
    this.clearFrameOverlay();

    await this.setBackground(snapshot.background, 0);
    if (signal?.aborted || this.destroyed) return;
    const stageEnv = snapshot.stageEnv;
    this.state.stage = snapshot.stage;
    this.state.pluginState = clonePlain(snapshot.pluginState ?? {});
    this.setVideoLayout(snapshot.videoLayout ? clonePlain(snapshot.videoLayout) : undefined);
    this.sceneTransforms.clear();
    for (const transform of snapshot.rendererState.transforms)
      this.sceneTransforms.set(transform.target, {
        current: { ...transform.current },
        planned: { ...transform.planned },
      });
    await this.screenEffects.restore(snapshot.screenEffects ?? [], signal);
    if (signal?.aborted || this.destroyed) return;
    for (const entry of this.screenFilters.values()) entry.controller.dispose();
    this.screenFilters.clear();
    for (const entry of snapshot.screenFilterState ?? [])
      this.screenFilter(entry.target)?.controller.restore(entry.state);
    this.applyStageEnv(stageEnv.focusPosition);
    this.applyStageLight(stageEnv.light);
    this.changeStageParticleEffects(stageEnv.effect);
    this.applyStagePostEffect(stageEnv.postEffect);
    this.state.stageEnv = clonePlain(stageEnv);

    this.stageOffsets.clear();
    for (const [positionType, offset] of snapshot.stageOffsets) {
      this.stageOffsets.set(Number(positionType), { ...offset });
    }
    Object.assign(this.cameraState, clonePlain(snapshot.cameraState));
    Object.assign(this.fieldRendererState, clonePlain(snapshot.fieldRendererState));
    if (snapshot.cameraShake.enabled) {
      await this.enableCameraShake(
        snapshot.cameraShake.strength,
        snapshot.cameraShake.cycleSeconds,
        snapshot.cameraShake.vibrato,
        snapshot.cameraShake.randomness,
        0,
      );
    }

    const snapshotControllerIdentities = new Set(snapshot.characters.map((character) => character.controllerIdentity));
    for (const [identity, item] of this.cachedCharacterControllers) {
      if (snapshotControllerIdentities.has(identity)) continue;
      this.speculativeCharacterControllers.set(identity, item);
      this.speculativeCharacterCommandIndices.set(identity, 0);
      this.resetLipSync(item);
      item.paused = false;
      item.pendingPausedMotion = null;
      item.pendingPausedExpression = null;
      this.invokeCharacterModel(item, "reset extra seek controller", undefined, (model) => model.setPaused(false));
    }

    const orderedCharacters = [...snapshot.characters].sort(
      (left, right) => Number(left.visible) - Number(right.visible),
    );
    for (const character of orderedCharacters) {
      if (signal?.aborted || this.destroyed) return;
      let item = this.cachedCharacterControllers.get(character.controllerIdentity);
      if (!item) {
        await this.placeCharacter(
          {
            targetName: character.target,
            targets: [{ target: character.target }],
            characterModel: character.entry,
            characterKey: character.characterKey,
            controllerIdentity: character.controllerIdentity,
            characterWorldPosition: character.worldPosition || undefined,
          },
          character.positionType,
          0,
          false,
        );
        if (signal?.aborted || this.destroyed) return;
        item = this.cachedCharacterControllers.get(character.controllerIdentity);
      }
      if (!item) {
        throw new Error(`ADV seek could not restore character ${character.target}`);
      }
      item.positionType = character.positionType;
      item.worldPosition = character.worldPosition ? { ...character.worldPosition } : null;
      Object.assign(item.offset, character.offset);
      item.alpha = character.alpha;
      item.brightness = character.brightness;
      item.facing = character.facing;
      item.roleAngle = character.roleAngle;
      item.angle = character.angle;
      item.bodyAngle = character.bodyAngle;
      item.angleOverride = character.angleOverride;
      item.lookX = character.lookX;
      item.lookY = character.lookY;
      item.lookOriginalX = character.lookOriginalX;
      item.lookOriginalY = character.lookOriginalY;
      item.lookOverride = character.lookOverride;
      item.blurIntensity = character.blurIntensity;
      item.sortingOrder = character.sortingOrder;
      item.rimLight = clonePlain(character.rimLight);
      item.currentMotionName = character.currentMotionName;
      item.currentMotionFadeInSeconds = character.currentMotionFadeInSeconds;
      item.currentExpressionName = character.currentExpressionName;
      item.currentExpressionFadeInSeconds = character.currentExpressionFadeInSeconds;
      item.activeExpressionName = character.activeExpressionName;
      item.activeExpressionFadeInSeconds = character.activeExpressionFadeInSeconds;
      item.pendingPausedMotion = character.pendingPausedMotion ? { ...character.pendingPausedMotion } : null;
      item.pendingPausedExpression = character.pendingPausedExpression
        ? { ...character.pendingPausedExpression }
        : null;
      item.harmonicTime = 0;
      item.lipSync = {
        ...character.lipSync,
        motionSyncPcm: null,
        sources: [],
        dampVelocity: { ...character.lipSync.dampVelocity },
        randomSeed: { ...character.lipSync.randomSeed },
      };
      item.paused = character.paused;
      this.invokeCharacterModel(item, "restore seek presentation", undefined, (model) => {
        model.setPaused(false);
        model.stopMotions();
        model.resetExpressionParametersToDefault();
        if (item.currentMotionName) model.playMotion(item.currentMotionName, 0);
        if (item.activeExpressionName) model.playExpression(item.activeExpressionName, 0);
        model.setMotionSpeed(this.playbackSpeedRate);
        if (item.paused) model.setPaused(true);
        model.primeInitialFrame(this.characterParameterFrame(item));
      });
      if (character.modelState !== undefined) await item.model.restoreSnapshot?.(character.modelState);
      if (signal?.aborted || this.destroyed) return;
      if (item.lookOverride) {
        this.invokeCharacterModel(item, "restore seek look", undefined, (model) =>
          model.setEyeBallPosition(item.lookX, item.lookY),
        );
      }
      this.characterPresentationHistory.set(
        character.target,
        character.presentation.map((event) => ({ ...event })),
      );
      this.layoutCharacter(item);
      if (character.visible) this.registerVisibleCharacter(character.target, item);
      if (character.speculative) {
        this.speculativeCharacterControllers.set(character.controllerIdentity, item);
        this.speculativeCharacterCommandIndices.set(character.controllerIdentity, 0);
      }
    }

    this.characterPriorityOrder = [...snapshot.lifecycle.characterPriorityOrder];
    this.characterControllerIdentities.clear();
    for (const [target, identity] of snapshot.lifecycle.characterControllerIdentities) {
      this.characterControllerIdentities.set(target, identity);
    }
    this.characterLoadTokens.clear();
    for (const [target, token] of snapshot.lifecycle.characterLoadTokens) {
      this.characterLoadTokens.set(target, token);
    }
    this.characterLoadSequence = Math.max(
      this.characterLoadSequence,
      snapshot.lifecycle.characterLoadSequence,
      0,
      ...snapshot.lifecycle.characterLoadTokens.map(([, token]) => token),
    );
    this.pendingCharacterCommands.restoreSnapshot(snapshot.lifecycle.pendingCharacters);

    await this.stageEffects.waitForPending();
    if (signal?.aborted || this.destroyed) return;
    for (const entry of snapshot.commandEffects) {
      await this.playCommandEffect(entry.effect, {
        atOnce: entry.atOnce,
        simulationSpeed: entry.simulationSpeed,
        positionType: entry.positionType,
        targetName: entry.targetName,
        canvasLayers: entry.canvasLayers,
      });
      if (signal?.aborted || this.destroyed) return;
    }
    const canvas = this.overlay?.canvasPass;
    if (canvas && snapshot.stillLayers) {
      ++this.stillGeneration;
      this.stillOperations.clear();
      canvas.clearStills();
      for (const layer of snapshot.stillLayers) {
        const presentation = this.context.rendererExtensions
          ?.service(STORY_STILL_PRESENTATION_PROVIDER)
          ?.resolve(layer.still);
        await canvas.showStill(layer.key, layer.still, layer.opacity, presentation, 0);
        if (signal?.aborted || this.destroyed) return;
        canvas.restoreStillAnimation(layer.key, layer.animation, layer.visible);
      }
      this.state.still = canvas.topStill;
    } else await this.setStill(snapshot.still, snapshot.stillAlpha, 0);
    if (signal?.aborted || this.destroyed) return;
    this.overlay?.setStillViewAlpha(snapshot.stillBackgroundAlpha, snapshot.stillOverlayAlpha);
    this.overlay?.setStillAnimationIndex(snapshot.stillAnimationIndex);
    this.state.frame = snapshot.frame;
    this.state.frameName = snapshot.frameName;
    this.state.frameOpacity = snapshot.frameOpacity;
    this.state.frameSlide = snapshot.frameSlide;
    this.state.frameEntries = clonePlain(snapshot.frameEntries);
    for (const [key, value] of Object.entries(this.state.frameEntries)) {
      if (!value.frame || value.opacity <= 0.001) continue;
      await this.setFrameOverlay(value.frame, value.opacity, key);
      if (signal?.aborted || this.destroyed) return;
      this.setFrameOpacity(value.opacity, value.slide, key);
    }
    this.overlay?.restoreFrameParticles(snapshot.frameParticles ?? {});

    this.commandVolumes.clear();
    for (const child of snapshot.commandVolumes) {
      this.commandVolumes.set(child.key, {
        profile: child.profile as UnityVolumeProfile,
        weight: clamp(child.weight),
        enabled: child.enabled,
        version: 0,
      });
    }
    this.commandPostEffect = [...this.commandVolumes.values()].find((child) => child.enabled)?.profile ?? null;
    this.state.commandPostEffect = this.commandPostEffect;
    this.state.postEffect = clonePlain(snapshot.postEffect);
    this.state.talk = clonePlain(snapshot.talk);
    this.state.title = clonePlain(snapshot.title);
    this.state.location = clonePlain(snapshot.location);
    this.state.subtitles = clonePlain(snapshot.subtitles);
    this.state.chat = clonePlain(snapshot.chat);
    this.state.choices = clonePlain(snapshot.choices);
    this.state.dofActive = snapshot.dofActive;
    this.state.effect = snapshot.effect;
    this.state.effects = clonePlain(snapshot.effects);
    this.setCover(snapshot.cover.color, snapshot.cover.opacity);
    this.syncPostPipeline();
    this.refreshStageNodes();
    this.applyTransforms();
  }

  focusPoint(positionType: unknown): Vec3 {
    return this.focusPointInternal(positionType);
  }

  characterAtPosition(positionType: unknown): StoryCharacter | null {
    const key = Number(positionType) || 0;
    for (const item of this.characterItems.values()) {
      if (item.positionType === key) return item;
    }
    return null;
  }

  setCameraRoll(angle: number, duration = 0, easeValue: unknown = 6, signal?: AbortSignal): Promise<void> {
    const from = this.cameraState.angle;
    const target = finite(angle);
    const token = this.beginCameraTween(["angle"]);
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, 6),
      signal,
      update: (progress) => {
        if (!this.ownsCameraTween(token, "angle")) return;
        this.cameraState.angle = lerp(from, target, progress);
        this.applyTransforms();
      },
    });
  }

  prepareLook(
    target: string,
    lookX: number,
    lookY: number,
    duration = 0,
    enabled = true,
  ): (() => Promise<void>) | null {
    const expectedItem = this.cachedCharacterController(target);
    const loadToken = expectedItem ? null : this.selectedPendingCharacterToken(target);
    if (!expectedItem && loadToken == null) return null;

    const targetX = finite(lookX);
    const targetY = finite(lookY);
    let stopX = 0;
    let stopY = 0;
    if (expectedItem) {
      if (enabled) {
        // SetLookEnabled(true) precedes DelaySeconds and captures the original
        // eye parameters on the first false -> true transition.
        this.enableLookOverride(expectedItem);
      } else {
        // Stop captures its return target before DelaySeconds but does not
        // disable the late Look override until the tween completes.
        // SetLookEnabled(false) clears OriginalLookX/Y, so a repeated Stop
        // samples zero while leaving the controller's current look fields free
        // to tween invisibly just as the native controller does.
        stopX = expectedItem.lookOverride ? expectedItem.lookOriginalX : 0;
        stopY = expectedItem.lookOverride ? expectedItem.lookOriginalY : 0;
      }
    } else if (enabled && loadToken != null) {
      this.pendingCharacterCommands.queueLookOverridePreparation(target, loadToken);
    }

    return async () => {
      if (expectedItem) {
        this.cancelPendingLookWait(target);
        if (enabled) {
          await this.tweenLook(expectedItem, targetX, targetY, duration, false);
        } else {
          await this.tweenLook(expectedItem, stopX, stopY, duration, true);
        }
        return;
      }
      if (loadToken == null || this.characterLoadTokens.get(target) !== loadToken) return;
      await this.setLook(target, targetX, targetY, duration, enabled);
    };
  }

  prepareLookTarget(
    target: string,
    targetPositionType: number,
    duration = 0,
    enabled = true,
    lookTargetName?: string,
  ): (() => Promise<void>) | null {
    if (!enabled) return this.prepareLook(target, 0, 0, duration, false);

    const sourceCharacter = this.cachedCharacterController(target);
    const sourceHead = sourceCharacter
      ? (this.applyTransforms(), this.characterHeadWorldPosition(sourceCharacter))
      : this.pendingCharacterHeadWorldPosition(target);
    const targetHead = this.characterHeadWorldPositionAtPosition(targetPositionType, lookTargetName);
    // Native exits immediately when either controller cannot be resolved;
    // DelaySeconds is not entered on this path.
    if (!sourceHead || !targetHead) return null;
    const look = computeAdvLookTarget(sourceHead, targetHead);
    return this.prepareLook(target, look.x, look.y, duration, true);
  }

  async setLook(target: string, lookX: number, lookY: number, duration = 0, enabled = true): Promise<void> {
    // RefreshLookCancellationToken cancels the preceding Look/Stop task before
    // either the loaded or Web-staged path starts the new linear tween.
    this.cancelPendingLookWait(target);
    const item = this.cachedCharacterController(target);
    if (!item) {
      const token = this.selectedPendingCharacterToken(target);
      const resolvedDuration = Math.max(0, finite(duration));
      if (
        token != null &&
        this.pendingCharacterCommands.queueLook(target, token, {
          kind: enabled ? "set" : "stop",
          x: finite(lookX),
          y: finite(lookY),
          durationSeconds: resolvedDuration,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        // A blocking Look command still owns its authored duration even while
        // the Web-only model load is pending. noWait callers detach this task.
        const controller = new AbortController();
        this.pendingLookWaitControllers.set(target, controller);
        try {
          await this.runTween({ duration: resolvedDuration, signal: controller.signal });
        } finally {
          if (this.pendingLookWaitControllers.get(target) === controller) {
            this.pendingLookWaitControllers.delete(target);
          }
        }
      }
      return;
    }
    if (!enabled) {
      await this.disableLookOverride(item, duration);
      return;
    }
    this.enableLookOverride(item);
    await this.tweenLook(item, finite(lookX), finite(lookY), duration, false);
  }

  /**
   * Fast-forward Look commands that Unity executed while its already-loaded
   * character existed, but the browser character was still being prepared.
   * Each new event cancels the preceding linear tween; Stop returns to the
   * eye position captured by the first active Set before releasing override.
   */
  private restorePendingLook(
    item: StoryCharacter,
    events: readonly PendingCharacterLookEvent[],
    overridePrepared = false,
  ): void {
    const sampled = this.invokeCharacterModel(item, "sample pending look", { x: item.lookX, y: item.lookY }, (model) =>
      model.eyeBallPosition(),
    );
    let originalX = sampled.x;
    let originalY = sampled.y;
    let currentX = sampled.x;
    let currentY = sampled.y;
    let override = overridePrepared;
    let tweenState: {
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly disableAfter: boolean;
    } | null = null;

    const advance = (seconds: number): void => {
      if (!tweenState) return;
      const duration = tweenState.endSeconds - tweenState.startSeconds;
      const progress = duration <= 0 ? 1 : clamp((seconds - tweenState.startSeconds) / duration);
      currentX = lerp(tweenState.fromX, tweenState.toX, progress);
      currentY = lerp(tweenState.fromY, tweenState.toY, progress);
      if (progress < 1) return;
      if (tweenState.disableAfter) override = false;
      tweenState = null;
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      if (event.kind === "set") {
        if (!override) {
          originalX = currentX;
          originalY = currentY;
        }
        override = true;
        tweenState = {
          startSeconds: event.queuedAtSeconds,
          endSeconds: event.queuedAtSeconds + Math.max(0, event.durationSeconds),
          fromX: currentX,
          fromY: currentY,
          toX: event.x,
          toY: event.y,
          disableAfter: false,
        };
      } else {
        tweenState = {
          startSeconds: event.queuedAtSeconds,
          endSeconds: event.queuedAtSeconds + Math.max(0, event.durationSeconds),
          fromX: currentX,
          fromY: currentY,
          toX: override ? originalX : 0,
          toY: override ? originalY : 0,
          disableAfter: true,
        };
      }
    }

    const now = this.monotonicSeconds();
    advance(now);
    item.lookOriginalX = originalX;
    item.lookOriginalY = originalY;
    item.lookX = currentX;
    item.lookY = currentY;
    item.lookOverride = override;
    if (override && tweenState) {
      const remaining = Math.max(0, tweenState.endSeconds - now);
      void this.tweenLook(item, tweenState.toX, tweenState.toY, remaining, tweenState.disableAfter);
    }
  }

  async setLookTarget(
    target: string,
    targetPositionType: number,
    duration = 0,
    enabled = true,
    lookTargetName?: string,
  ): Promise<void> {
    this.cancelPendingLookWait(target);
    const sourceCharacter = this.cachedCharacterController(target);
    if (!sourceCharacter) {
      if (!enabled) {
        await this.setLook(target, 0, 0, duration, false);
        return;
      }
      const sourceHead = this.pendingCharacterHeadWorldPosition(target);
      const targetHead = this.characterHeadWorldPositionAtPosition(targetPositionType, lookTargetName);
      if (!sourceHead || !targetHead) {
        this.cancelPendingLookWait(target);
        return;
      }
      const look = computeAdvLookTarget(sourceHead, targetHead);
      await this.setLook(target, look.x, look.y, duration, true);
      return;
    }
    if (!enabled) {
      await this.disableLookOverride(sourceCharacter, duration);
      return;
    }

    const targetHead = this.characterHeadWorldPositionAtPosition(targetPositionType, lookTargetName);
    if (!targetHead) return;

    // GetHeadPosition returns the anchor's current Transform.position. Flush
    // same-frame no-wait stage changes before reading the equivalent world
    // matrices, then preserve the complete parent transform chain.
    this.applyTransforms();
    const sourceHead = this.characterHeadWorldPosition(sourceCharacter);
    const look = computeAdvLookTarget(sourceHead, targetHead);
    this.enableLookOverride(sourceCharacter);
    await this.tweenLook(sourceCharacter, look.x, look.y, duration, false);
  }

  private enableLookOverride(item: StoryCharacter): void {
    if (item.lookOverride) return;
    const original = this.invokeCharacterModel(item, "sample look", { x: item.lookX, y: item.lookY }, (model) =>
      model.eyeBallPosition(),
    );
    item.lookOriginalX = original.x;
    item.lookOriginalY = original.y;
    item.lookX = original.x;
    item.lookY = original.y;
    item.lookOverride = true;
  }

  private async disableLookOverride(item: StoryCharacter, duration: number): Promise<void> {
    if (!item.lookOverride) {
      // OriginalLookX/Y are zero after SetLookEnabled(false). The controller
      // still tweens its private current fields on a repeated Stop, but because
      // Look remains disabled those values never overwrite the model.
      await this.tweenLook(item, 0, 0, duration, true);
      return;
    }
    await this.tweenLook(item, item.lookOriginalX, item.lookOriginalY, duration, true);
  }

  private async tweenLook(
    item: StoryCharacter,
    targetX: number,
    targetY: number,
    duration: number,
    disableAfter: boolean,
  ): Promise<void> {
    item.lookTweenController?.abort();
    const controller = new AbortController();
    item.lookTweenController = controller;
    const abort = (): void => controller.abort();
    const lifecycleSignal = this.lifecycleController.signal;
    if (lifecycleSignal.aborted) controller.abort();
    else lifecycleSignal.addEventListener("abort", abort, { once: true });
    const fromX = item.lookX;
    const fromY = item.lookY;
    const forceUpdateNow = Math.max(0, finite(duration)) <= 0;
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (progress) => {
          item.lookX = lerp(fromX, targetX, progress);
          item.lookY = lerp(fromY, targetY, progress);
          // A positive-duration SmoothChangeToLook only advances controller
          // fields; OnLateUpdate applies them to character plugin (and Pause can skip
          // that application). Its <= 0 fast path uniquely calls
          // ForceUpdateNow, which #343 depends on for same-command visibility.
          if (forceUpdateNow) {
            this.invokeCharacterModel(item, "force look update", undefined, (model) =>
              model.forceEyeBallPosition(item.lookX, item.lookY),
            );
          }
        },
      });
      if (item.lookTweenController === controller && !controller.signal.aborted && disableAfter) {
        item.lookOverride = false;
        // Disabling provider-controlled look clears only the
        // captured originals. It deliberately retains the final LookX/Y.
        item.lookOriginalX = 0;
        item.lookOriginalY = 0;
      }
    } finally {
      lifecycleSignal.removeEventListener("abort", abort);
      if (item.lookTweenController === controller) item.lookTweenController = null;
    }
  }

  prepareCharacterAngle(target: string, angle: number, bodyAngle: number, duration = 0): (() => Promise<void>) | null {
    const expectedItem = this.cachedCharacterController(target);
    const loadToken = expectedItem ? null : this.selectedPendingCharacterToken(target);
    if (!expectedItem && loadToken == null) return null;

    // SetOverrideAngleEnabled(true, true) is the synchronous preparation step
    // before DelaySeconds. A cancelled delay intentionally leaves it enabled.
    if (expectedItem) expectedItem.angleOverride = true;
    else if (loadToken != null) {
      this.pendingCharacterCommands.queueAngleOverridePreparation(target, loadToken);
    }
    return async () => {
      if (expectedItem) {
        await this.tweenCharacterAngle(expectedItem, finite(angle), finite(bodyAngle), Math.max(0, finite(duration)));
        return;
      }
      if (loadToken == null || this.characterLoadTokens.get(target) !== loadToken) return;
      await this.setCharacterAngle(target, angle, bodyAngle, duration);
    };
  }

  async setCharacterAngle(target: string, angle: number, bodyAngle: number, duration = 0): Promise<void> {
    // AdvAngleCommand refreshes a per-character cancellation token before
    // SmoothRotateToAngle. Keep that ownership while the Web-only lazy load is
    // pending as well, so an obsolete blocking command is released promptly.
    this.cancelPendingAngleWait(target);
    const item = this.cachedCharacterController(target);
    const resolvedDuration = Math.max(0, finite(duration));
    if (!item) {
      const token = this.selectedPendingCharacterToken(target);
      if (
        token != null &&
        this.pendingCharacterCommands.queueAngle(target, token, {
          angle: finite(angle),
          bodyAngle: finite(bodyAngle),
          durationSeconds: resolvedDuration,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        const controller = new AbortController();
        this.pendingAngleWaitControllers.set(target, controller);
        try {
          await this.runTween({ duration: resolvedDuration, signal: controller.signal });
        } finally {
          if (this.pendingAngleWaitControllers.get(target) === controller) {
            this.pendingAngleWaitControllers.delete(target);
          }
        }
      }
      return;
    }
    await this.tweenCharacterAngle(item, finite(angle), finite(bodyAngle), resolvedDuration);
  }

  private async tweenCharacterAngle(
    item: StoryCharacter,
    targetAngle: number,
    targetBodyAngle: number,
    duration: number,
    resumed?: {
      readonly fromAngle: number;
      readonly fromBodyAngle: number;
      readonly startRaw: number;
    },
  ): Promise<void> {
    item.angleTweenController?.abort();
    const controller = new AbortController();
    item.angleTweenController = controller;
    const abort = (): void => controller.abort();
    const lifecycleSignal = this.lifecycleController.signal;
    if (lifecycleSignal.aborted) controller.abort();
    else lifecycleSignal.addEventListener("abort", abort, { once: true });

    item.angleOverride = true;
    const fromAngle = resumed?.fromAngle ?? item.angle;
    const fromBodyAngle = resumed?.fromBodyAngle ?? item.bodyAngle;
    const startRaw = clamp(resumed?.startRaw ?? 0);
    const ease = resolveEase(15, 15);
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (_progress, raw) => {
          // When a pending browser load completes mid-tween, continue the
          // original OutQuint curve instead of restarting easing from zero.
          const originalRaw = startRaw + (1 - startRaw) * raw;
          const progress = ease(originalRaw);
          item.angle = lerp(fromAngle, targetAngle, progress);
          item.bodyAngle = lerp(fromBodyAngle, targetBodyAngle, progress);
        },
      });
    } finally {
      lifecycleSignal.removeEventListener("abort", abort);
      if (item.angleTweenController === controller) item.angleTweenController = null;
    }
  }

  /**
   * Reconstruct Angle events issued after a no-wait In while the browser was
   * fetching character plugin assets. Native has a preloaded controller at that point,
   * so each event starts immediately and cancels the previous OutQuint tween.
   */
  private restorePendingAngle(item: StoryCharacter, events: readonly PendingCharacterAngleEvent[]): void {
    const ease = resolveEase(15, 15);
    let currentAngle = 0;
    let currentBodyAngle = 0;
    let tweenState: {
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly fromAngle: number;
      readonly fromBodyAngle: number;
      readonly toAngle: number;
      readonly toBodyAngle: number;
    } | null = null;

    const advance = (seconds: number): number => {
      if (!tweenState) return 1;
      const duration = tweenState.endSeconds - tweenState.startSeconds;
      const raw = duration <= 0 ? 1 : clamp((seconds - tweenState.startSeconds) / duration);
      const progress = ease(raw);
      currentAngle = lerp(tweenState.fromAngle, tweenState.toAngle, progress);
      currentBodyAngle = lerp(tweenState.fromBodyAngle, tweenState.toBodyAngle, progress);
      if (raw >= 1) tweenState = null;
      return raw;
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      tweenState = {
        startSeconds: event.queuedAtSeconds,
        endSeconds: event.queuedAtSeconds + Math.max(0, event.durationSeconds),
        fromAngle: currentAngle,
        fromBodyAngle: currentBodyAngle,
        toAngle: finite(event.angle),
        toBodyAngle: finite(event.bodyAngle),
      };
    }

    const now = this.monotonicSeconds();
    const startRaw = advance(now);
    item.angleOverride = events.length > 0;
    item.angle = currentAngle;
    item.bodyAngle = currentBodyAngle;
    if (tweenState) {
      const remaining = Math.max(0, tweenState.endSeconds - now);
      void this.tweenCharacterAngle(item, tweenState.toAngle, tweenState.toBodyAngle, remaining, {
        fromAngle: tweenState.fromAngle,
        fromBodyAngle: tweenState.fromBodyAngle,
        startRaw,
      });
    }
  }

  moveCharacter(
    positionType: number,
    delta: { x?: number; y?: number; z?: number },
    duration = 0,
    easeValue: unknown = "OutQuad",
  ): Promise<void> {
    const offset = this.stageOffsetInternal(positionType);
    const start = { ...offset };
    const end = {
      x: start.x + finite(delta.x),
      y: start.y + finite(delta.y),
      z: start.z + finite(delta.z),
    };
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      update: (progress) => {
        offset.x = lerp(start.x, end.x, progress);
        offset.y = lerp(start.y, end.y, progress);
        offset.z = lerp(start.z, end.z, progress);
        this.refreshStageNodes();
      },
    });
  }

  /** Move one controller through authored 3D world space without affecting its slot peers. */
  moveCharacterToWorld(
    target: string,
    position: { x: number; y: number; z: number },
    positionType: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
  ): Promise<void> {
    const destination = worldPosition(position);
    if (!destination) return Promise.resolve();
    const item = this.characterItems.get(target) || this.cachedCharacterController(target);
    if (!item) {
      const pending = this.pendingCharacterPlacements.get(target);
      if (pending && pending.token === this.characterLoadTokens.get(target)) {
        this.pendingCharacterWorldPositions.set(target, {
          token: pending.token,
          positionType: Number(positionType) || pending.positionType || 5,
          position: destination,
        });
      }
      return Promise.resolve();
    }
    const destinationPosition = Number(positionType) || item.positionType || 5;
    let start = this.characterAuthoredWorldPosition(item);
    if (destinationPosition !== item.positionType) {
      const destinationParent = this.stageNode(destinationPosition);
      this.applyTransforms();
      this.scene.updateMatrixWorld(true);
      destinationParent.attach(item.node);
      const local = threeVector3ToUnity(item.node.position, this.placementUnityPosition);
      const field = this.fieldPosition("character", { x: 0, y: 0, z: 0 });
      const stage = this.stagePoint(destinationPosition);
      const fieldScale = this.fieldScale("character");
      start = {
        x: field.x + stage.x + local.x * fieldScale - item.offset.x,
        y: field.y + stage.y + local.y * fieldScale - item.offset.y,
        z: field.z + stage.z + local.z * fieldScale - item.offset.z,
      };
    }
    item.worldPosition = { ...start };
    item.positionType = destinationPosition;
    this.layoutCharacter(item);
    const update = (progress: number): void => {
      if (!item.worldPosition) item.worldPosition = { ...start };
      item.worldPosition.x = lerp(start.x, destination.x, progress);
      item.worldPosition.y = lerp(start.y, destination.y, progress);
      item.worldPosition.z = lerp(start.z, destination.z, progress);
      this.layoutCharacter(item);
    };
    if (duration <= 0) {
      update(1);
      return Promise.resolve();
    }
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      update,
    });
  }

  async setRendererCharacterBrightness(
    targetName: string,
    value: number,
    duration = 0,
    positionType = 0,
  ): Promise<void> {
    const entryPosition = Number(positionType) || this.characterItems.get(targetName)?.positionType || 0;
    const ownershipKey = `entry:${entryPosition}`;
    const item = this.characterItems.get(targetName);
    if (!item) {
      const token = this.characterLoadTokens.get(targetName);
      const seconds = Math.max(0, finite(duration));
      if (
        token != null &&
        this.pendingCharacterCommands.queueBrightness(targetName, token, {
          route: "renderer",
          positionType: entryPosition,
          value: clamp(value),
          durationSeconds: seconds,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        const controller = this.replaceCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey);
        try {
          await this.runTween({ duration: seconds, signal: controller.signal });
        } finally {
          this.releaseCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey, controller);
        }
      }
      return;
    }
    await this.tweenRendererCharacterBrightness(item, value, duration, undefined, undefined, ownershipKey);
  }

  private async tweenRendererCharacterBrightness(
    item: StoryCharacter,
    value: number,
    duration = 0,
    resumed?: { readonly from: number; readonly startRaw: number },
    existingController?: AbortController,
    ownershipKey = `entry:${item.positionType}`,
  ): Promise<void> {
    const controller =
      existingController ||
      this.replaceCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey);
    const ownsController = !existingController;
    const from = resumed?.from ?? item.brightness;
    const startRaw = clamp(resumed?.startRaw ?? 0);
    const ease = resolveEase(6);
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (_progress, rawProgress) => {
          const originalRaw = lerp(startRaw, 1, rawProgress);
          item.brightness = lerp(from, clamp(value), ease(originalRaw));
        },
      });
    } finally {
      if (ownsController) {
        this.releaseCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey, controller);
      }
    }
  }

  /** Provider brightness: current-value lerp, no per-property cancellation. */
  async setBrightness(targetName: string, value: number, duration = 0): Promise<void> {
    const target = clamp(value);
    const seconds = Math.max(0, finite(duration));
    const item = this.cachedCharacterController(targetName);
    if (!item) {
      const token = this.selectedPendingCharacterToken(targetName);
      if (
        token != null &&
        this.pendingCharacterCommands.queueBrightness(targetName, token, {
          route: "direct",
          value: target,
          durationSeconds: seconds,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        await this.runTween({ duration: seconds });
      }
      return;
    }
    await this.tweenDirectCharacterBrightness(item, target, seconds);
  }

  private tweenDirectCharacterBrightness(
    item: StoryCharacter,
    value: number,
    duration: number,
    startRaw = 0,
  ): Promise<void> {
    const initialRaw = clamp(startRaw);
    return this.runTween({
      duration,
      update: (_progress, raw) => {
        const originalRaw = lerp(initialRaw, 1, raw);
        item.brightness = lerp(item.brightness, clamp(value), originalRaw);
      },
    });
  }

  private restorePendingBrightness(item: StoryCharacter, events: readonly PendingCharacterBrightness[]): void {
    const targetFrameRate = Math.max(1, finite(this.runtime.targetFrameRate, 45));
    const frameSeconds = 1 / targetFrameRate;
    let current = 1;
    let renderer: {
      readonly event: PendingCharacterBrightness;
      readonly from: number;
      nextFrameSeconds: number;
    } | null = null;
    const direct: Array<{ readonly event: PendingCharacterBrightness; nextFrameSeconds: number }> = [];
    const advance = (untilSeconds: number): void => {
      while (true) {
        const nextSeconds = Math.min(
          renderer?.nextFrameSeconds ?? Number.POSITIVE_INFINITY,
          ...direct.map((entry) => entry.nextFrameSeconds),
        );
        if (!Number.isFinite(nextSeconds) || nextSeconds > untilSeconds) break;
        if (renderer && renderer.nextFrameSeconds <= nextSeconds) {
          const duration = Math.max(0, renderer.event.durationSeconds);
          const raw = duration <= 0 ? 1 : clamp((nextSeconds - renderer.event.queuedAtSeconds) / duration);
          current = lerp(renderer.from, clamp(renderer.event.value), resolveEase(6)(raw));
          if (raw >= 1) renderer = null;
          else renderer.nextFrameSeconds += frameSeconds;
        }
        for (let index = 0; index < direct.length;) {
          const entry = direct[index];
          if (entry.nextFrameSeconds > nextSeconds) {
            index += 1;
            continue;
          }
          const duration = Math.max(0, entry.event.durationSeconds);
          const raw = duration <= 0 ? 1 : clamp((nextSeconds - entry.event.queuedAtSeconds) / duration);
          current = lerp(current, clamp(entry.event.value), raw);
          if (raw >= 1) direct.splice(index, 1);
          else {
            entry.nextFrameSeconds += frameSeconds;
            index += 1;
          }
        }
      }
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      const duration = Math.max(0, event.durationSeconds);
      if (duration <= 0) {
        current = clamp(event.value);
        if (event.route === "renderer") renderer = null;
      } else if (event.route === "renderer") {
        renderer = { event, from: current, nextFrameSeconds: event.queuedAtSeconds + frameSeconds };
      } else {
        direct.push({ event, nextFrameSeconds: event.queuedAtSeconds + frameSeconds });
      }
    }

    const now = this.monotonicSeconds();
    advance(now);
    item.brightness = current;
    if (renderer) {
      const duration = Math.max(0, renderer.event.durationSeconds);
      const elapsed = Math.max(0, now - renderer.event.queuedAtSeconds);
      const ownershipKey = `entry:${Number(renderer.event.positionType) || item.positionType}`;
      const controller = this.characterBrightnessTweenControllers.get(ownershipKey);
      void this.tweenRendererCharacterBrightness(
        item,
        clamp(renderer.event.value),
        Math.max(0, duration - elapsed),
        { from: renderer.from, startRaw: clamp(elapsed / duration) },
        controller,
        ownershipKey,
      );
    }
    for (const entry of direct) {
      const duration = Math.max(0, entry.event.durationSeconds);
      const elapsed = Math.max(0, now - entry.event.queuedAtSeconds);
      void this.tweenDirectCharacterBrightness(
        item,
        clamp(entry.event.value),
        Math.max(0, duration - elapsed),
        clamp(elapsed / duration),
      );
    }
  }

  async setPositionBrightness(positionType: number, value: number, duration = 0): Promise<void> {
    const item = this.characterAtPosition(positionType);
    if (item) await this.setRendererCharacterBrightness(item.target, value, duration, Number(positionType) || 0);
  }

  setBackgroundBrightness(value: number, duration = 0): Promise<void> {
    return this.tweenBackgroundBrightness(value, duration);
  }

  private async tweenBackgroundBrightness(value: number, duration = 0): Promise<void> {
    const from = this.fieldRendererState.brightness;
    const target = clamp(value, 0, 1);
    await this.runTween({
      duration,
      // DOTweenModuleSprite.DOColor uses DOTween's default OutQuad ease.
      ease: resolveEase(6),
      update: (progress) => {
        this.fieldRendererState.brightness = lerp(from, target, progress);
        this.applyTransforms();
      },
    });
  }

  async setBackgroundDoF(
    intensity: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.qualityConfig.isBackgroundBlurEnabled()) return;
    const controller = this.replaceBackgroundBlurTweenController();
    const unbind = this.bindControllerToSignal(controller, signal);
    const version = ++this.backgroundBlurTweenVersion;
    const from = this.fieldRendererState.backgroundBlur;
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        ease: resolveEase(easeValue, this.runtime.focusEase),
        update: (progress) => {
          if (version !== this.backgroundBlurTweenVersion) return;
          // SetBackgroundBlurAsync clamps the requested intensity to [0,1]
          // before applying the quality gate.
          this.fieldRendererState.backgroundBlur = lerp(from, clamp(intensity), progress);
          this.syncFieldPostEffects();
        },
      });
    } finally {
      unbind();
      if (this.backgroundBlurTweenController === controller) this.backgroundBlurTweenController = null;
    }
  }

  async setCharacterDoF(
    targetName: string,
    intensity: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.qualityConfig.isCharacterBlurEnabled()) return;
    const item = this.characterItems.get(targetName);
    if (!item) {
      const token = this.characterLoadTokens.get(targetName);
      const seconds = Math.max(0, finite(duration));
      if (
        token != null &&
        this.pendingCharacterCommands.queueDoF(targetName, token, {
          kind: "set",
          intensity: clamp(intensity),
          durationSeconds: seconds,
          ease: easeValue,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        const controller = this.replaceCharacterTweenController(this.characterBlurTweenControllers, targetName);
        const unbind = this.bindControllerToSignal(controller, signal);
        try {
          await this.runTween({ duration: seconds, signal: controller.signal });
        } finally {
          unbind();
          this.releaseCharacterTweenController(this.characterBlurTweenControllers, targetName, controller);
        }
      }
      return;
    }
    await this.tweenCharacterDoF(item, intensity, duration, easeValue, undefined, undefined, signal);
  }

  cancelPendingCharacterDoF(targetName: string): void {
    const token = this.characterLoadTokens.get(targetName);
    if (token != null) {
      this.pendingCharacterCommands.queueDoFCancel(targetName, token, this.monotonicSeconds());
    }
  }

  private async tweenCharacterDoF(
    item: StoryCharacter,
    intensity: number,
    duration: number,
    easeValue: unknown,
    resumed?: { readonly from: number; readonly startRaw: number },
    existingController?: AbortController,
    signal?: AbortSignal,
  ): Promise<void> {
    const targetName = item.target;
    const controller =
      existingController || this.replaceCharacterTweenController(this.characterBlurTweenControllers, targetName);
    const ownsController = !existingController;
    const unbind = ownsController ? this.bindControllerToSignal(controller, signal) : () => {};
    const version = (this.characterBlurTweenVersions.get(targetName) || 0) + 1;
    this.characterBlurTweenVersions.set(targetName, version);
    const from = resumed?.from ?? item.blurIntensity;
    const startRaw = clamp(resumed?.startRaw ?? 0);
    const ease = resolveEase(easeValue, this.runtime.focusEase);
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (_progress, raw) => {
          if (version !== this.characterBlurTweenVersions.get(targetName)) return;
          // SetCharacterBlurAsync applies the same [0,1] clamp.
          const originalRaw = startRaw + (1 - startRaw) * raw;
          item.blurIntensity = lerp(from, clamp(intensity), ease(originalRaw));
        },
      });
    } finally {
      unbind();
      if (ownsController) {
        this.releaseCharacterTweenController(this.characterBlurTweenControllers, targetName, controller);
      }
    }
  }

  private restorePendingDoF(item: StoryCharacter, events: readonly PendingCharacterDoF[]): void {
    if (!this.qualityConfig.isCharacterBlurEnabled()) return;
    let current = item.blurIntensity;
    let active: { readonly event: PendingCharacterDoFSet; readonly from: number } | null = null;
    const advance = (untilSeconds: number): void => {
      if (!active) return;
      const duration = Math.max(0, active.event.durationSeconds);
      const elapsed = Math.max(0, untilSeconds - active.event.queuedAtSeconds);
      const progress = duration <= 0 ? 1 : clamp(elapsed / duration);
      const ease = resolveEase(active.event.ease, this.runtime.focusEase);
      current = lerp(active.from, clamp(active.event.intensity), ease(progress));
      if (progress >= 1) active = null;
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      if (event.kind === "cancel") {
        active = null;
        continue;
      }
      const duration = Math.max(0, event.durationSeconds);
      if (duration <= 0) {
        current = clamp(event.intensity);
        active = null;
      } else {
        active = { event, from: current };
      }
    }

    const now = this.monotonicSeconds();
    advance(now);
    item.blurIntensity = current;
    if (!active) return;
    const duration = Math.max(0, active.event.durationSeconds);
    const elapsed = Math.max(0, now - active.event.queuedAtSeconds);
    const startRaw = clamp(elapsed / duration);
    const controller = this.characterBlurTweenControllers.get(item.target);
    void this.tweenCharacterDoF(
      item,
      clamp(active.event.intensity),
      Math.max(0, duration - elapsed),
      active.event.ease,
      { from: active.from, startRaw },
      controller,
    );
  }

  private restorePendingAlpha(item: StoryCharacter, events: readonly PendingCharacterAlphaEvent[]): void {
    const latest = events.at(-1);
    if (!latest) return;
    this.characterAlphaOperations.set(item.target, latest.operationId);
    const now = this.monotonicSeconds();
    const duration = Math.max(0, latest.durationSeconds);
    const elapsed = latest.startedAtSeconds == null ? 0 : Math.max(0, now - latest.startedAtSeconds);
    const startRaw = latest.startedAtSeconds == null ? 0 : duration <= 0 ? 1 : clamp(elapsed / duration);
    item.alpha = lerp(latest.from, clamp(latest.value), startRaw);
    if (latest.startedAtSeconds == null || startRaw >= 1) return;
    void this.fadeCharacterLifecycle(item, latest.from, clamp(latest.value), Math.max(0, duration - elapsed), {
      delayFrames: 0,
      startRaw,
    });
  }

  private restorePendingRimLight(item: StoryCharacter, events: readonly PendingCharacterRimLightEvent[]): void {
    for (const event of events) {
      item.rimLight = {
        enabled: !item.rimLight.enabled,
        color: { ...event.color },
        shadowIntensity: event.shadowIntensity,
      };
    }
  }

  setRimLight(targetName: string, colorValue: unknown, shadowIntensity: number): Promise<void> {
    const item = this.cachedCharacterController(targetName);
    const event: PendingCharacterRimLightEvent = {
      color: unityHtmlColor(colorValue),
      shadowIntensity: finite(shadowIntensity),
    };
    if (!item) {
      const token = this.selectedPendingCharacterToken(targetName);
      if (token != null) this.pendingCharacterCommands.queueRimLight(targetName, token, event);
      return Promise.resolve();
    }
    item.rimLight = {
      enabled: !item.rimLight.enabled,
      color: { ...event.color },
      shadowIntensity: event.shadowIntensity,
    };
    return Promise.resolve();
  }

  startTimedPseudoLipSync(targets: string[] | string, talkLength: number, speed = 1, multiplier = 1): void {
    this.startTimedPseudoLipSyncSeconds(
      targets,
      Math.max(0, Math.trunc(finite(talkLength))) * PSEUDO_LIP_UNIT_TIME,
      speed,
      multiplier,
    );
  }

  startTimedHoldOpenPseudoLipSync(
    targets: string[] | string,
    mouthOpening: number,
    talkLength: number,
    speed = 1,
  ): void {
    const durationSeconds = Math.max(0, Math.trunc(finite(talkLength))) * PSEUDO_LIP_UNIT_TIME;
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMouthOpening = finite(mouthOpening, 1) || 1;
    const queuedAtSeconds = this.monotonicSeconds();
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const item = this.cachedCharacterController(target);
      if (item) {
        this.applyTimedLipSync(item, durationSeconds, resolvedSpeed, 1, "hold-open", resolvedMouthOpening);
        continue;
      }
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) {
        this.pendingCharacterCommands.queueLipSync(target, token, {
          source: "timed",
          timedMode: "hold-open",
          holdOpenLevel: resolvedMouthOpening,
          durationSeconds,
          speed: resolvedSpeed,
          multiplier: 1,
          queuedAtSeconds,
        });
      }
    }
  }

  startTimedPseudoLipSyncSeconds(targets: string[] | string, seconds: number, speed = 1, multiplier = 1): void {
    const durationSeconds = Math.max(0, finite(seconds));
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMultiplier = Math.max(0, finite(multiplier, 1));
    const queuedAtSeconds = this.monotonicSeconds();
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const item = this.cachedCharacterController(target);
      if (item) {
        this.applyTimedLipSync(item, durationSeconds, resolvedSpeed, resolvedMultiplier);
        continue;
      }
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) {
        this.pendingCharacterCommands.queueLipSync(target, token, {
          source: "timed",
          timedMode: "oscillating",
          durationSeconds,
          speed: resolvedSpeed,
          multiplier: resolvedMultiplier,
          queuedAtSeconds,
        });
      }
    }
  }

  startVoiceLipSync(
    targets: string[] | string,
    voiceEntries: readonly VegaVoiceAnalysisSource[],
    duration: number,
    speed = 1,
    multiplier = 1,
  ): boolean {
    const sources = voiceEntries.filter(Boolean) as VoiceAnalysisSource[];
    if (!sources.length) return false;
    const durationSeconds = Math.max(0, finite(duration));
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMultiplier = Math.max(0, finite(multiplier, 1));
    const queuedAtSeconds = this.monotonicSeconds();
    let started = false;
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const item = this.cachedCharacterController(target);
      if (item) {
        this.applyVoiceLipSync(item, sources, durationSeconds, resolvedSpeed, resolvedMultiplier);
        started = true;
        continue;
      }
      const token = this.selectedPendingCharacterToken(target);
      if (
        token != null &&
        this.pendingCharacterCommands.queueLipSync(target, token, {
          source: "voice",
          sources,
          voiceSpeed: resolvedSpeed,
          voiceMultiplier: resolvedMultiplier,
          voiceExpiresAtSeconds: queuedAtSeconds + durationSeconds / resolvedSpeed,
          durationSeconds,
          speed: resolvedSpeed,
          multiplier: resolvedMultiplier,
          queuedAtSeconds,
        })
      ) {
        started = true;
      }
    }
    return started;
  }

  private monotonicSeconds(): number {
    return (globalThis.performance?.now?.() ?? Date.now()) / 1000;
  }

  private applyTimedLipSync(
    item: StoryCharacter,
    seconds: number,
    speed: number,
    multiplier: number,
    timedMode: "oscillating" | "hold-open" = "oscillating",
    holdOpenLevel = 0,
  ): void {
    Object.assign(item.lipSync, {
      enabled: true,
      source: "timed",
      timedMode,
      holdOpenLevel,
      timedRemaining: Math.max(0, finite(seconds)),
      stopRemaining: 0,
      speed: Math.max(0.001, finite(speed, 1)),
      multiplier: Math.max(0, finite(multiplier, 1)),
      mouthForm: 0,
      motionSyncPcm: null,
    });
  }

  private restoreTimedLipSyncAtTime(
    item: StoryCharacter,
    pending: PendingCharacterLipSync,
    pauseEvents: readonly PendingCharacterPauseEvent[],
    now: number,
  ): void {
    if (pending.sources?.length) item.lipSync.sources = [...pending.sources] as VoiceAnalysisSource[];
    item.lipSync.voiceSpeed = Math.max(0.001, finite(pending.voiceSpeed, 1));
    item.lipSync.voiceMultiplier = Math.max(0, finite(pending.voiceMultiplier, 1));
    item.lipSync.voiceExpiresAtSeconds = Math.max(0, finite(pending.voiceExpiresAtSeconds));
    const duration = Math.max(0, pending.durationSeconds);
    this.applyTimedLipSync(
      item,
      duration,
      pending.speed,
      pending.multiplier,
      pending.timedMode ?? "oscillating",
      finite(pending.holdOpenLevel),
    );
    const frameSeconds = 1 / Math.max(1, finite(this.runtime.targetFrameRate, 45));
    const start = pending.queuedAtSeconds;
    let paused = false;
    let playbackRate = 1;
    for (const event of pauseEvents) {
      if (event.queuedAtSeconds <= start) paused = event.paused;
    }
    for (const event of this.playbackSpeedEvents) {
      if (event.queuedAtSeconds <= start) playbackRate = event.rate;
    }
    const events = [
      ...pauseEvents
        .filter((event) => event.queuedAtSeconds > start && event.queuedAtSeconds <= now)
        .map((event) => ({ ...event, kind: "pause" as const })),
      ...this.playbackSpeedEvents
        .filter((event) => event.queuedAtSeconds > start && event.queuedAtSeconds <= now)
        .map((event) => ({ ...event, kind: "speed" as const })),
    ].sort((left, right) => left.queuedAtSeconds - right.queuedAtSeconds);
    let eventIndex = 0;
    // Replay complete native update frames only. In particular, do not use a
    // duration+tail continuous threshold: the crossing frame arms the close
    // tail without consuming it, which is observably one-frame later.
    for (let frameTime = start + frameSeconds; frameTime <= now + 1e-9; frameTime += frameSeconds) {
      while (eventIndex < events.length && events[eventIndex].queuedAtSeconds <= frameTime) {
        const event = events[eventIndex++];
        if (event.kind === "pause") paused = event.paused;
        else playbackRate = event.rate;
      }
      if (!paused) this.advanceTimedLipSyncFrame(item, frameSeconds, playbackRate);
      if (item.lipSync.source !== "timed") break;
    }
  }

  private applyVoiceLipSync(
    item: StoryCharacter,
    sources: VoiceAnalysisSource[],
    durationSeconds: number,
    speed: number,
    multiplier: number,
  ): void {
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMultiplier = Math.max(0, finite(multiplier, 1));
    Object.assign(item.lipSync, {
      enabled: true,
      source: "voice",
      timedMode: "oscillating",
      holdOpenLevel: 0,
      timedRemaining: 0,
      voiceRemaining: Math.max(0, finite(durationSeconds)),
      voiceSpeed: resolvedSpeed,
      voiceMultiplier: resolvedMultiplier,
      voiceExpiresAtSeconds: this.monotonicSeconds() + Math.max(0, finite(durationSeconds)) / resolvedSpeed,
      stopRemaining: 0,
      speed: resolvedSpeed,
      multiplier: resolvedMultiplier,
      timer: 0,
      isOpen: false,
      mouthOpenY: 0,
      mouthForm: 0,
      motionSyncPcm: null,
      dampVelocity: { value: 0 },
      sources,
    });
    this.invokeCharacterModel(item, "start voice motion sync", undefined, (model) => model.resetMotionSync());
  }

  private restorePendingLipSync(
    item: StoryCharacter,
    pending: PendingCharacterLipSync,
    pauseEvents: readonly PendingCharacterPauseEvent[],
  ): void {
    const now = this.monotonicSeconds();
    if (pending.source === "timed") {
      this.restoreTimedLipSyncAtTime(item, pending, pauseEvents, now);
      return;
    }

    // The CRI/Howl voice player keeps advancing while the character animation
    // is paused or covered by timed pseudo lip-sync. Use its wall-clock
    // deadline rather than freezing an artificial controller countdown.
    const voiceSpeed = Math.max(0.001, finite(pending.voiceSpeed, pending.speed));
    const voiceMultiplier = Math.max(0, finite(pending.voiceMultiplier, pending.multiplier));
    const expiresAt = finite(
      pending.voiceExpiresAtSeconds,
      pending.queuedAtSeconds + Math.max(0, pending.durationSeconds) / voiceSpeed,
    );
    const remaining = Math.max(0, (expiresAt - now) * voiceSpeed);
    const sources = (pending.sources || []).filter(Boolean) as VoiceAnalysisSource[];
    if (sources.length) {
      this.applyVoiceLipSync(item, sources, remaining, voiceSpeed, voiceMultiplier);
    }
  }

  stopTimedPseudoLipSync(targets: string[] | string): void {
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) this.pendingCharacterCommands.clearTimedLipSync(target, token);
      const item = this.cachedCharacterController(target);
      if (!item || item.lipSync.source !== "timed") continue;
      // Stopping timed pseudo lip sync does not run the
      // natural 0.3 s timeout release. For TimedPseudo/HoldOpen it clears the
      // timer, immediately returns to the available voice mode and refreshes
      // the mouth controller. The 0.3 s close is exclusive to a timer that
      // expires naturally in OnLateUpdate.
      this.stopTimedLipSyncNow(item);
    }
  }

  stopAllTimedPseudoLipSync(): void {
    this.pendingCharacterCommands.clearAllTimedLipSync();
    for (const item of new Set(this.cachedCharacterControllers.values())) {
      if (item.lipSync.source === "timed") this.stopTimedLipSyncNow(item);
    }
  }

  /** StopTimedPseudoLipSync switches mode without calling ResetLip. */
  private stopTimedLipSyncNow(item: StoryCharacter): void {
    this.leaveTimedLipSync(item);
  }

  private leaveTimedLipSync(item: StoryCharacter): void {
    const voiceSpeed = Math.max(0.001, item.lipSync.voiceSpeed);
    Object.assign(item.lipSync, {
      // Native chooses LipMode 1/2 from controller configuration here; it
      // never disables merely because no browser voice source is bound.
      enabled: true,
      source: "voice",
      timedRemaining: 0,
      voiceRemaining: Math.max(0, (item.lipSync.voiceExpiresAtSeconds - this.monotonicSeconds()) * voiceSpeed),
      stopRemaining: 0,
      speed: voiceSpeed,
      multiplier: item.lipSync.voiceMultiplier,
      motionSyncPcm: null,
    });
  }

  stopSpeaking(targets: string[] | string): void {
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) this.pendingCharacterCommands.clearLipSync(target, token);
      const item = this.cachedCharacterController(target);
      if (item) this.resetLipSync(item);
    }
  }

  stopAllSpeaking(): void {
    this.pendingCharacterCommands.clearAllLipSync();
    for (const item of new Set(this.cachedCharacterControllers.values())) this.resetLipSync(item);
  }

  private currentFocusDataTable(): readonly AdvFocusDataRow[] {
    return (
      FOCUS_DATA_BY_KEY[this.focusDataSettingsKey] || this.runtime.focusData || FOCUS_DATA_BY_KEY["Settings-Default"]
    );
  }

  currentFocusData(distance: number): AdvFocusDataRow | null {
    const target = clampCameraDistance(Math.round(finite(distance)));
    return this.currentFocusDataTable().find((row) => row.cameraDistance === target) || null;
  }

  closestFocusDataByZoomRatio(ratio: number): AdvFocusDataRow | null {
    const rows = this.currentFocusDataTable();
    if (!rows.length) return null;
    const value = finite(ratio, 1);
    return rows.reduce((best, row) =>
      Math.abs(row.fieldZoomRatio - value) < Math.abs(best.fieldZoomRatio - value) ? row : best,
    );
  }

  private characterHeadWorldPosition(item: StoryCharacter): Vec3 {
    const authoredHead = item.entry.profile?.anchors?.head?.position;
    if (authoredHead) {
      return computeAdvCharacterHeadWorldPosition(item.node, vec3(authoredHead, ZERO_VEC3));
    }
    const bounds = this.invokeCharacterModel(
      item,
      "read character bounds",
      { x: -0.5, y: -1, width: 1, height: 2 },
      (model) => model.drawableBounds(true) || model.canvasBounds(),
    );
    return computeAdvCharacterHeadWorldPosition(item.node, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
      z: 0,
    });
  }

  private pendingCharacterHeadWorldPosition(target: string): Vec3 | null {
    const staged = this.stagedCharacterItems.get(target);
    if (staged && staged.token === this.characterLoadTokens.get(target)) {
      this.applyTransforms();
      return this.characterHeadWorldPosition(staged.item);
    }

    const pending = this.pendingCharacterPlacements.get(target);
    if (!pending || pending.token !== this.characterLoadTokens.get(target)) return null;
    const head = pending.entry.profile?.anchors?.head?.position;
    if (!head) return null;
    const pendingWorld = this.pendingCharacterWorldPositions.get(target);
    const positionType = pendingWorld?.token === pending.token ? pendingWorld.positionType : pending.positionType;
    const authoredWorld = pendingWorld?.token === pending.token ? pendingWorld.position : pending.worldPosition;
    const stage = this.stageNode(positionType);
    this.applyTransforms();
    const node = new Object3D();
    const profile = pending.entry.profile || {};
    const basePosition = vec3(profile.basePosition, { x: 0, y: -0.41, z: 0 });
    const scale = Math.max(0.001, finite(profile.baseScale, 1.6));
    if (authoredWorld) {
      const fieldPosition = this.fieldPosition("character", { x: 0, y: 0, z: 0 });
      const stagePosition = this.stagePoint(positionType);
      const fieldScale = this.fieldScale("character");
      basePosition.x = (authoredWorld.x - fieldPosition.x - stagePosition.x) / fieldScale;
      basePosition.y = (authoredWorld.y - fieldPosition.y - stagePosition.y) / fieldScale;
      basePosition.z = (authoredWorld.z - fieldPosition.z - stagePosition.z) / fieldScale;
    }
    unityVector3(
      {
        x: basePosition.x,
        y: basePosition.y,
        z: basePosition.z,
      },
      node.position,
    );
    node.scale.setScalar(scale);
    stage.add(node);
    try {
      return computeAdvCharacterHeadWorldPosition(node, vec3(head, { x: 0, y: 0, z: 0 }));
    } finally {
      node.removeFromParent();
    }
  }

  private characterHeadWorldPositionAtPosition(positionType: number, targetName?: string): Vec3 | null {
    if (targetName !== undefined) {
      // AdvPlaybackSession.TryGetPositionTypeToCharacter, not the renderer's
      // showing map, owns LookTarget resolution. Out leaves that mapping and
      // its cached controller alive, so a hidden character remains a valid
      // head target. Pending/staged entries are the Web-only async equivalent
      // of the already-loaded native controller.
      if (!targetName) return null;
      const pendingHead = this.pendingCharacterHeadWorldPosition(targetName);
      if (pendingHead) return pendingHead;
      const cached = this.cachedCharacterController(targetName);
      if (!cached) return null;
      this.applyTransforms();
      return this.characterHeadWorldPosition(cached);
    }
    const item = this.characterAtPosition(positionType);
    if (item) {
      this.applyTransforms();
      return this.characterHeadWorldPosition(item);
    }
    for (const [target, pending] of this.pendingCharacterPlacements) {
      if (pending.positionType !== positionType) continue;
      const head = this.pendingCharacterHeadWorldPosition(target);
      if (head) return head;
    }
    return null;
  }

  focusBaseCameraPosition(positionType: number, targetName = "", focusData: AdvFocusDataRow | null = null): Vec3 {
    const point = this.focusPointInternal(positionType);
    const namedItem = targetName ? this.characterItems.get(targetName) : null;
    const pendingHead = !namedItem && targetName ? this.pendingCharacterHeadWorldPosition(targetName) : null;
    // AdvFocusCommand resolves GetHeadPosition only after its explicit
    // TargetName succeeds in TryGetCharacterController. A position-only Focus
    // therefore keeps the authored fieldZoomOffsetY even when that slot happens
    // to contain a character.
    const item = namedItem;
    if (item) this.applyTransforms();
    return {
      x: point.x,
      y: AdvCamera.focusTargetY(
        finite(focusData?.fieldZoomOffsetY),
        item ? this.characterHeadWorldPosition(item).y : pendingHead?.y,
        finite(focusData?.characterHeadFocusOffsetY),
      ),
      z: 0,
    };
  }

  private beginCameraTween(keys: readonly string[]): Record<string, number> {
    const token: Record<string, number> = {};
    for (const key of keys) {
      const next = (this.cameraTweenVersions[key] || 0) + 1;
      this.cameraTweenVersions[key] = next;
      token[key] = next;
    }
    return token;
  }

  private ownsCameraTween(token: Readonly<Record<string, number>>, key: string): boolean {
    return token[key] === this.cameraTweenVersions[key];
  }

  private fieldRendererValuesForDistance(distance: number, gateByFocusDataSettings: boolean) {
    const index = clampCameraDistance(Math.round(finite(distance)));
    const focus = this.currentFocusData(index);
    return {
      distance: index,
      blurRadiusMax: finite(this.runtime.fieldRenderer.blurRadiusMaxByCameraDistance[index], 0.75),
      curvedLensRate: finite(this.runtime.fieldRenderer.curvedLensIntensityRateByCameraDistance[index], 1),
      backgroundBlur:
        (!gateByFocusDataSettings || this.runtime.focusBackgroundBlurEnabled) &&
        this.qualityConfig.isBackgroundBlurEnabled()
          ? clamp(focus?.backgroundBlurIntensity)
          : 0,
      characterBlur:
        (!gateByFocusDataSettings || this.runtime.focusCharacterBlurEnabled) &&
        this.qualityConfig.isCharacterBlurEnabled()
          ? clamp(focus?.characterBlurIntensity)
          : 0,
    };
  }

  focus({
    positionType = 5,
    targetName = "",
    cameraDistance = 0,
    duration = 0,
    ease = "OutQuad",
    signal,
  }: {
    positionType?: number;
    targetName?: string;
    cameraDistance?: number;
    duration?: number;
    ease?: unknown;
    signal?: AbortSignal;
  }): Promise<void> {
    const session = this.state.session as { tryGetTargetNameToPositionType?: (name: string) => number } | null;
    const position = AdvCamera.focusCommandPositionType(
      positionType,
      targetName,
      (name) => session?.tryGetTargetNameToPositionType?.(name) || 0,
    );
    const distance = clampCameraDistance(cameraDistance);
    const focusData = this.currentFocusData(distance);
    const targetBase = this.focusBaseCameraPosition(position, targetName, focusData);
    // AdvFocusCommand reads both FocusDataSettings flags; AdvZoomCommand does
    // not, so keep this gate explicit at the command boundary.
    const rendererTarget = this.fieldRendererValuesForDistance(distance, true);
    const startCamera = { ...this.cameraState };
    const startRenderer = { ...this.fieldRendererState };
    this.cancelBackgroundBlurTween();
    const backgroundBlurVersion = ++this.backgroundBlurTweenVersion;
    const characterBlurTweens = [...this.characterItems.values()].map((item) => {
      this.cancelCharacterBlurTween(item.target);
      const version = (this.characterBlurTweenVersions.get(item.target) || 0) + 1;
      this.characterBlurTweenVersions.set(item.target, version);
      return {
        item,
        version,
        from: item.blurIntensity,
        to: item.positionType === position ? 0 : rendererTarget.characterBlur,
      };
    });
    const token = this.beginCameraTween([
      "focusMeta",
      "baseX",
      "baseY",
      "baseZ",
      "rotationY",
      "stageRotationY",
      "zoomRatio",
      "panOffsetX",
      "panOffsetY",
      "renderer",
    ]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "focusMeta")) {
          this.cameraState.focusPositionType = position;
          this.cameraState.focusTargetName = targetName;
        }
        if (this.ownsCameraTween(token, "baseX"))
          this.cameraState.baseX = lerp(startCamera.baseX, targetBase.x, progress);
        if (this.ownsCameraTween(token, "baseY"))
          this.cameraState.baseY = lerp(startCamera.baseY, targetBase.y, progress);
        if (this.ownsCameraTween(token, "baseZ"))
          this.cameraState.baseZ = lerp(startCamera.baseZ, targetBase.z, progress);
        if (this.ownsCameraTween(token, "rotationY"))
          this.cameraState.rotationY = lerp(startCamera.rotationY, 0, progress);
        if (this.ownsCameraTween(token, "stageRotationY"))
          this.cameraState.stageRotationY = lerp(startCamera.stageRotationY, 0, progress);
        if (this.ownsCameraTween(token, "zoomRatio"))
          this.cameraState.zoomRatio = lerp(
            startCamera.zoomRatio,
            Math.max(0.001, finite(focusData?.fieldZoomRatio, 1)),
            progress,
          );
        if (this.ownsCameraTween(token, "panOffsetX"))
          this.cameraState.panOffsetX = lerp(startCamera.panOffsetX, 0, progress);
        if (this.ownsCameraTween(token, "panOffsetY"))
          this.cameraState.panOffsetY = lerp(startCamera.panOffsetY, 0, progress);
        if (this.ownsCameraTween(token, "renderer")) {
          this.fieldRendererState.distance = lerp(startRenderer.distance, rendererTarget.distance, progress);
          this.fieldRendererState.blurRadiusMax = lerp(
            startRenderer.blurRadiusMax,
            rendererTarget.blurRadiusMax,
            progress,
          );
          this.fieldRendererState.curvedLensRate = lerp(
            startRenderer.curvedLensRate,
            rendererTarget.curvedLensRate,
            progress,
          );
          this.fieldRendererState.characterBlur = lerp(
            startRenderer.characterBlur,
            rendererTarget.characterBlur,
            progress,
          );
        }
        if (backgroundBlurVersion === this.backgroundBlurTweenVersion) {
          this.fieldRendererState.backgroundBlur = lerp(
            startRenderer.backgroundBlur,
            rendererTarget.backgroundBlur,
            progress,
          );
        }
        for (const blur of characterBlurTweens) {
          if (blur.version !== this.characterBlurTweenVersions.get(blur.item.target)) continue;
          blur.item.blurIntensity = lerp(blur.from, blur.to, progress);
        }
        this.syncFieldPostEffects();
        this.applyTransforms();
      },
    });
  }

  zoomByRatio(
    ratio: number,
    duration = 0,
    ease: unknown = "OutQuad",
    backgroundBlurOffset: number | null = null,
    adjustBackgroundBlur = true,
    signal?: AbortSignal,
  ): Promise<void> {
    const targetRatio = Math.max(0.001, finite(ratio, 1));
    const focus = this.closestFocusDataByZoomRatio(targetRatio);
    const targetRenderer = this.fieldRendererValuesForDistance(focus?.cameraDistance || 0, false);
    if (backgroundBlurOffset != null && this.qualityConfig.isBackgroundBlurEnabled()) {
      targetRenderer.backgroundBlur = finite(focus?.backgroundBlurIntensity) + finite(backgroundBlurOffset);
    }
    const startRatio = this.cameraState.zoomRatio;
    const startRenderer = { ...this.fieldRendererState };
    let backgroundBlurVersion = this.backgroundBlurTweenVersion;
    if (adjustBackgroundBlur) {
      this.cancelBackgroundBlurTween();
      backgroundBlurVersion = ++this.backgroundBlurTweenVersion;
    }
    const token = this.beginCameraTween(["zoomRatio", "renderer"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "zoomRatio"))
          this.cameraState.zoomRatio = lerp(startRatio, targetRatio, progress);
        if (this.ownsCameraTween(token, "renderer")) {
          this.fieldRendererState.distance = lerp(startRenderer.distance, targetRenderer.distance, progress);
          this.fieldRendererState.blurRadiusMax = lerp(
            startRenderer.blurRadiusMax,
            targetRenderer.blurRadiusMax,
            progress,
          );
          this.fieldRendererState.curvedLensRate = lerp(
            startRenderer.curvedLensRate,
            targetRenderer.curvedLensRate,
            progress,
          );
        }
        if (adjustBackgroundBlur && backgroundBlurVersion === this.backgroundBlurTweenVersion) {
          this.fieldRendererState.backgroundBlur = lerp(
            startRenderer.backgroundBlur,
            targetRenderer.backgroundBlur,
            progress,
          );
        }
        this.syncFieldPostEffects();
      },
    });
  }

  setCharacterStagesY(
    angle: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    const fieldFrom = this.cameraState.fieldRotationY;
    const target = finite(angle);
    // AdvPanCommand rotates the background/character field roots. It does not
    // rotate the SceneCamera itself (that is a separate serialized channel).
    const token = this.beginCameraTween(["fieldRotationY"]);
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "fieldRotationY"))
          this.cameraState.fieldRotationY = lerp(fieldFrom, target, progress);
        this.applyTransforms();
      },
    });
  }

  setTilt(angle: number, duration = 0, easeValue: unknown = "OutQuad", signal?: AbortSignal): Promise<void> {
    const from = this.cameraState.rotationX;
    const target = finite(angle);
    const token = this.beginCameraTween(["rotationX"]);
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (!this.ownsCameraTween(token, "rotationX")) return;
        this.cameraState.rotationX = lerp(from, target, progress);
        this.applyTransforms();
      },
    });
  }

  panFocusDistance(focusPosition: { z?: number }): number {
    return Math.abs(this.fieldPosition("character", this.scratchCharacterPosition).z - finite(focusPosition.z));
  }

  panV2CameraOffset(rotationY: number, distance: number, focusSlideRate: number): Vec2 {
    const radians = finite(rotationY) * DEG_TO_RAD;
    const radiusRate = 1 - finite(focusSlideRate, 0.5);
    return {
      x: -radiusRate * finite(distance) * Math.sin(radians),
      y: radiusRate * finite(distance) * (1 - Math.cos(radians)),
    };
  }

  setPanV2CameraOffset(
    offset: { x?: number; y?: number },
    duration = 0,
    ease: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    const from = { x: this.cameraState.panOffsetX, y: this.cameraState.panOffsetY };
    const target = { x: finite(offset.x), y: finite(offset.y) };
    const token = this.beginCameraTween(["panOffsetX", "panOffsetY"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "panOffsetX")) this.cameraState.panOffsetX = lerp(from.x, target.x, progress);
        if (this.ownsCameraTween(token, "panOffsetY")) this.cameraState.panOffsetY = lerp(from.y, target.y, progress);
      },
    });
  }

  setPanV2BaseCameraPosition(
    position: { x?: number; y?: number; z?: number },
    duration = 0,
    ease: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    const from = { x: this.cameraState.baseX, y: this.cameraState.baseY, z: this.cameraState.baseZ };
    const target = { x: finite(position.x), y: finite(position.y), z: finite(position.z) };
    const token = this.beginCameraTween(["baseX", "baseY", "baseZ"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "baseX")) this.cameraState.baseX = lerp(from.x, target.x, progress);
        if (this.ownsCameraTween(token, "baseY")) this.cameraState.baseY = lerp(from.y, target.y, progress);
        if (this.ownsCameraTween(token, "baseZ")) this.cameraState.baseZ = lerp(from.z, target.z, progress);
      },
    });
  }

  panV2({
    rotationY = 0,
    cameraOffset = { x: 0, y: 0 },
    duration = 0,
    ease = "OutQuad",
    signal,
  }: {
    rotationY?: number;
    cameraOffset?: { x?: number; y?: number };
    cameraDistance?: number;
    duration?: number;
    ease?: unknown;
    signal?: AbortSignal;
  }): Promise<void> {
    const from = {
      rotationY: this.cameraState.rotationY,
      stageRotationY: this.cameraState.stageRotationY,
      panOffsetX: this.cameraState.panOffsetX,
      panOffsetY: this.cameraState.panOffsetY,
    };
    // AdvPanV2 rotates both ICamera.RotateY and the five character stage
    // transforms while applying the versine-derived X/Z camera offset.
    const token = this.beginCameraTween(["rotationY", "stageRotationY", "panOffsetX", "panOffsetY"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "rotationY"))
          this.cameraState.rotationY = lerp(from.rotationY, finite(rotationY), progress);
        if (this.ownsCameraTween(token, "stageRotationY"))
          this.cameraState.stageRotationY = lerp(from.stageRotationY, finite(rotationY), progress);
        if (this.ownsCameraTween(token, "panOffsetX"))
          this.cameraState.panOffsetX = lerp(from.panOffsetX, finite(cameraOffset.x), progress);
        if (this.ownsCameraTween(token, "panOffsetY"))
          this.cameraState.panOffsetY = lerp(from.panOffsetY, finite(cameraOffset.y), progress);
        this.applyTransforms();
      },
    });
  }

  private shakeScene(
    kind: "background" | "character" | "still" | "talk",
    strength: number,
    duration: number,
    vibrato: number,
    randomness: number,
    fadeOut: boolean,
  ): Promise<void> {
    // Each native target owns its own tween. A new Shake stops only a selected
    // target; disjoint layers from an earlier command continue independently.
    this.commandShakeControllers.get(kind)?.abort();
    this.resetCommandShake(kind);
    const controller = new AbortController();
    this.commandShakeControllers.set(kind, controller);
    const path = createAdvDotweenShakePath({
      duration,
      strength,
      vibrato,
      randomness,
      fadeOut,
      // AdvFieldBase receives Vector3(strength, strength, 0), while the two
      // UI views use DOShakeAnchorPos's scalar/ignore-Z overload.
      vectorBased: kind === "background" || kind === "character",
    });
    return this.runTween({
      duration,
      signal: controller.signal,
      update: (progress) => {
        if (this.commandShakeControllers.get(kind) !== controller) return;
        const { x, y } = sampleAdvDotweenShake(path, progress);
        if (kind === "background") this.backgroundShake = { x, y };
        else if (kind === "character") this.characterShake = { x, y };
        else if (kind === "still") {
          const uiScale = Math.max(0, finite(this.state.viewport.height)) / ADV_UI_REFERENCE_HEIGHT;
          this.overlay?.setStillOffset(x * uiScale, y * uiScale);
        } else {
          const uiScale = Math.max(0, finite(this.state.viewport.height)) / ADV_UI_REFERENCE_HEIGHT;
          this.state.talk.shakeX = x * uiScale;
          this.state.talk.shakeY = y * uiScale;
        }
      },
    }).finally(() => {
      if (this.commandShakeControllers.get(kind) !== controller) return;
      this.commandShakeControllers.delete(kind);
      this.resetCommandShake(kind);
    });
  }

  private resetCommandShake(kind: "background" | "character" | "still" | "talk"): void {
    if (kind === "background") this.backgroundShake = { x: 0, y: 0 };
    else if (kind === "character") this.characterShake = { x: 0, y: 0 };
    else if (kind === "still") this.overlay?.setStillOffset(0, 0);
    else {
      this.state.talk.shakeX = 0;
      this.state.talk.shakeY = 0;
    }
  }

  shakeCommand(
    fieldStrength: number,
    uiStrength: number,
    duration: number,
    vibrato: number,
    randomness: number,
    fadeOut: boolean,
    layers?: number[],
  ): Promise<void> {
    // CanvasLayers.Count == 0 is the native all-supported-layers branch.
    const layerSet = new Set((layers?.length ? layers : [0, 2, 7, 9]).map(Number));
    const tasks: Promise<void>[] = [];
    if (layerSet.has(0)) {
      tasks.push(this.shakeScene("background", fieldStrength, duration, vibrato, randomness, fadeOut));
    }
    if (layerSet.has(2)) {
      tasks.push(this.shakeScene("character", fieldStrength, duration, vibrato, randomness, fadeOut));
    }
    // AdvShakeCommand routes CanvasLayer.Still and CanvasLayer.Talk to their
    // independent UIAdvWidget shake targets. Other DOM layers are untouched.
    if (layerSet.has(7)) {
      tasks.push(this.shakeScene("still", uiStrength, duration, vibrato, randomness, fadeOut));
    }
    if (layerSet.has(9)) {
      tasks.push(this.shakeScene("talk", uiStrength, duration, vibrato, randomness, fadeOut));
    }
    return Promise.all(tasks).then(() => undefined);
  }

  private resetAllCommandShakes(): void {
    this.resetCommandShake("background");
    this.resetCommandShake("character");
    this.resetCommandShake("still");
    this.resetCommandShake("talk");
  }

  private resetShakeState(): void {
    for (const controller of this.commandShakeControllers.values()) controller.abort();
    this.commandShakeControllers.clear();
    this.resetAllCommandShakes();

    const cameraController = this.cameraShakeFadeController;
    this.cameraShakeFadeController = null;
    cameraController?.abort();
    this.cameraShakeStopPromise = null;
    this.cameraShake = { x: 0, y: 0 };
    this.cameraShakeMode = "idle";
    this.cameraShakeCycleElapsed = 0;
    this.cameraShakeFadeElapsed = 0;
    this.cameraShakeFadeSeconds = 0;
    this.cameraShakeWeight = 0;
    this.cameraShakeStrength = 0;
    this.cameraShakeCycleSeconds = 1;
    this.cameraShakeVibrato = 2;
    this.cameraShakeRandomness = 60;
    this.cameraShakePath = null;
    this.cameraShakeCycleStart = { x: 0, y: 0 };
    this.cameraShakeWaitNextCycle = false;

    // WebGL field/camera offsets and DOM still/talk offsets must all observe
    // the same synchronous reset before snapshot restoration starts.
    this.applyTransforms();
  }

  isCameraShakePlaying(): boolean {
    return this.cameraShakeMode === "playing";
  }

  async enableCameraShake(
    strength: number,
    shakeDuration: number,
    vibrato: number,
    randomness: number,
    fadeDuration: number,
  ): Promise<void> {
    const fadeSeconds = Math.max(0, finite(fadeDuration));
    // An already-Playing Enable is ignored, but Stopping is interruptible: a
    // new Enable refreshes the token and starts another Playing lifecycle.
    // The command still owns its fade delay in the ignored branch.
    if (this.cameraShakeMode === "playing") {
      await this.runTween({ duration: fadeSeconds });
      return;
    }
    const startup = this.cameraShakeMode === "stopping" ? { ...this.cameraShake } : { x: 0, y: 0 };
    this.cameraShakeFadeController?.abort();
    this.cameraShakeStopPromise = null;
    const controller = new AbortController();
    this.cameraShakeFadeController = controller;
    this.cameraShakeMode = "playing";
    this.cameraShake = startup;
    this.cameraShakeFadeElapsed = 0;
    this.cameraShakeFadeSeconds = fadeSeconds;
    this.cameraShakeWeight = fadeSeconds > 0 ? 0 : 1;
    this.cameraShakeStrength = Math.max(0, finite(strength));
    this.cameraShakeCycleSeconds = Math.max(0.001, finite(shakeDuration, 1));
    this.cameraShakeVibrato = Math.max(1, finite(vibrato, 2));
    this.cameraShakeRandomness = finite(randomness, 60);
    this.beginPersistentCameraShakeCycle(startup);
    try {
      await this.runTween({
        duration: fadeSeconds,
        signal: controller.signal,
      });
    } finally {
      if (this.cameraShakeFadeController === controller) this.cameraShakeFadeController = null;
    }
  }

  async disableCameraShake(fadeDuration: number): Promise<void> {
    if (this.cameraShakeMode === "idle") return;
    if (this.cameraShakeMode === "stopping") {
      await this.cameraShakeStopPromise;
      return;
    }
    this.cameraShakeFadeController?.abort();
    const controller = new AbortController();
    this.cameraShakeFadeController = controller;
    this.cameraShakeMode = "stopping";
    this.cameraShakeFadeElapsed = 0;
    this.cameraShakeFadeSeconds = Math.max(0, finite(fadeDuration));
    this.cameraShakeWeight = this.cameraShakeFadeSeconds > 0 ? 1 : 0;
    // Disable starts a fresh non-fading DOTween cycle and waits for that whole
    // cycle. If the fade is longer than one cycle, native recursively starts
    // another complete cycle until Time.time - disableStartTime reaches the
    // fade duration. Only that final completion restores the Boot position.
    const task: Promise<void> = (async () => {
      do {
        this.beginPersistentCameraShakeCycle({ ...this.cameraShake });
        await this.runTween({
          duration: this.cameraShakeCycleSeconds,
          signal: controller.signal,
        });
        if (this.cameraShakeFadeController !== controller || controller.signal.aborted) return;
      } while (this.cameraShakeFadeElapsed < this.cameraShakeFadeSeconds);
    })()
      .then(() => {
        if (this.cameraShakeFadeController !== controller || controller.signal.aborted) return;
        this.cameraShakeMode = "idle";
        this.cameraShakeWeight = 0;
        this.cameraShake = { x: 0, y: 0 };
        this.cameraShakePath = null;
        this.cameraShakeWaitNextCycle = false;
      })
      .finally(() => {
        if (this.cameraShakeFadeController === controller) this.cameraShakeFadeController = null;
        if (this.cameraShakeStopPromise === task) this.cameraShakeStopPromise = null;
      });
    this.cameraShakeStopPromise = task;
    await task;
  }

  private beginPersistentCameraShakeCycle(startup: Vec2): void {
    this.cameraShakeCycleStart = { ...startup };
    this.cameraShakeCycleElapsed = 0;
    this.cameraShakeWaitNextCycle = false;
    this.cameraShakePath = createAdvDotweenShakePath({
      duration: this.cameraShakeCycleSeconds,
      strength: this.cameraShakeStrength,
      vibrato: this.cameraShakeVibrato,
      randomness: this.cameraShakeRandomness,
      fadeOut: false,
      vectorBased: true,
    });
  }

  private updatePersistentCameraShake(deltaSeconds: number): void {
    if (this.cameraShakeMode === "idle") {
      this.cameraShake = { x: 0, y: 0 };
      return;
    }
    const delta = Math.max(0, finite(deltaSeconds));
    this.cameraShakeFadeElapsed += delta;
    this.cameraShakeWeight =
      this.cameraShakeMode === "playing"
        ? this.cameraShakeFadeSeconds > 0
          ? clamp(this.cameraShakeFadeElapsed / this.cameraShakeFadeSeconds)
          : 1
        : this.cameraShakeFadeSeconds > 0
          ? clamp(1 - this.cameraShakeFadeElapsed / this.cameraShakeFadeSeconds)
          : 0;

    // Enable recursively creates a freshly-randomized tween one frame after
    // each cycle completes. Preserve that NextFrame gap instead of wrapping a
    // single periodic waveform/path.
    if (this.cameraShakeWaitNextCycle) {
      if (this.cameraShakeMode === "playing") this.beginPersistentCameraShakeCycle(this.cameraShake);
      return;
    }
    if (!this.cameraShakePath) this.beginPersistentCameraShakeCycle(this.cameraShake);
    this.cameraShakeCycleElapsed += delta;
    const progress = clamp(this.cameraShakeCycleElapsed / this.cameraShakeCycleSeconds);
    const pathOffset = sampleAdvDotweenShake(this.cameraShakePath!, progress);
    const current = {
      x: this.cameraShakeCycleStart.x + pathOffset.x,
      y: this.cameraShakeCycleStart.y + pathOffset.y,
    };
    this.cameraShake = {
      x: current.x * this.cameraShakeWeight,
      y: current.y * this.cameraShakeWeight,
    };
    if (progress >= 1 && this.cameraShakeMode === "playing") {
      this.cameraShakePath = null;
      this.cameraShakeWaitNextCycle = true;
    }
  }

  private characterStageIndex(positionType: number): number {
    const value = Math.trunc(Number(positionType));
    return value >= 1 && value <= 9 && value % 2 === 1 ? (value - 1) / 2 : -1;
  }

  private characterPriority(positionType: number): number {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return this.characterPriorityOrder.length;
    const priority = this.characterPriorityOrder.indexOf(index);
    return priority >= 0 ? priority : this.characterPriorityOrder.length;
  }
}
