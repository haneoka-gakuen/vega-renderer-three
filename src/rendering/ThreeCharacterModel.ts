import type { AdvVoicePcmSnapshot, StoryCharacterRendererModel } from "@haneoka/vega/renderer-kit";
import type { Matrix4 } from "three";

export type ThreeCharacterMotionSyncStatus = "unconfigured" | "loading" | "ready" | "failed" | "released";

export interface ThreeCharacterParameterBlend {
  readonly id: string;
  readonly value: number;
  /** 0=override, 1=additive, 2=multiply. */
  readonly mode: 0 | 1 | 2;
}

export interface ThreeCharacterParameterFrame {
  angleX?: number;
  bodyAngleX?: number;
  lookX?: number;
  lookY?: number;
  focusX?: number;
  focusY?: number;
  mouthOpenY?: number;
  mouthForm?: number;
  motionSyncPcm?: AdvVoicePcmSnapshot | null;
  motionSyncWeight?: number;
  overrides?: Readonly<Record<string, number>>;
  blends?: readonly ThreeCharacterParameterBlend[];
}

export interface ThreeCharacterBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ThreeCharacterDrawState {
  /** Three-basis world matrix supplied to renderer-aware character plugins. */
  readonly objectToWorld?: Matrix4;
  readonly timeSeconds?: number;
}

export type ThreeRendererVec3 = readonly [x: number, y: number, z: number];
export type ThreeRendererVec4 = readonly [x: number, y: number, z: number, w: number];

export interface ThreeRendererSphericalHarmonics {
  readonly ar: ThreeRendererVec4;
  readonly ag: ThreeRendererVec4;
  readonly ab: ThreeRendererVec4;
  readonly br: ThreeRendererVec4;
  readonly bg: ThreeRendererVec4;
  readonly bb: ThreeRendererVec4;
  readonly c: ThreeRendererVec4;
}

export interface ThreeRendererAdditionalLight {
  readonly position: ThreeRendererVec4;
  readonly color: ThreeRendererVec3;
  readonly attenuation: ThreeRendererVec4;
  readonly spotDirection: ThreeRendererVec3;
}

export interface ThreeRendererLightState {
  readonly enabled: boolean;
  readonly disableForMultiplicativeDrawables: boolean;
  readonly mainLightPosition: ThreeRendererVec4;
  readonly mainLightColor: ThreeRendererVec3;
  readonly sphericalHarmonics: ThreeRendererSphericalHarmonics;
  readonly additionalLights?: readonly ThreeRendererAdditionalLight[];
}

export interface ThreeRendererMultiplyTextureOptions {
  readonly enabled?: boolean;
  readonly uv?: readonly [number, number, number, number];
  readonly intensity?: number;
  readonly amplitude?: readonly [number, number];
  readonly frequency?: number;
}

/**
 * GPU model contract owned by the Three renderer.
 *
 * Format plugins implement this contract through `createForRenderer`; the
 * renderer never imports or initializes their SDKs.
 */
export interface ThreeStoryCharacterModel extends StoryCharacterRendererModel {
  readonly format: string;
  readonly modelUrl: string;
  readonly pixelsPerUnit: number;
  readonly isOperational: boolean;
  readonly updateSerial: number;
  readonly drawSerial: number;
  readonly isMotionPlaying: boolean;
  readonly motionSyncStatus: ThreeCharacterMotionSyncStatus;

  setPaused(paused: boolean): void;
  setMotionSpeed(speed: number): void;
  setEyeBlinkEnabled(enabled: boolean): void;
  resetExpressionParametersToDefault(): void;
  hasMotion(name: string): boolean;
  /**
   * Reports whether an expression key exists before lazy preparation starts.
   * Older renderer adapters may omit this hook; the renderer then falls back
   * to the entry's explicit expression catalogue.
   */
  hasExpression?(name: string): boolean;
  stopMotions(): void;
  drawableBounds(visibleOnly?: boolean): ThreeCharacterBounds | null;
  canvasBounds(): ThreeCharacterBounds;
  resetMotionSync(): void;
  setClockSuspended?(suspended: boolean): void;
  createSnapshot?(): unknown;
  restoreSnapshot?(snapshot: unknown): void | Promise<void>;

  playMotion(name: string, fadeInSeconds?: number): boolean;
  playExpression(name: string, fadeInSeconds?: number): boolean;
  /**
   * Resolve only a known animation's asynchronous dependencies. `true` means
   * an immediate `play*` call performs no resource I/O. `false` never counts
   * as warmed: it may mean unknown/unsupported, while a key known through the
   * model catalogue is treated by the renderer as a preparation failure.
   */
  prepareMotion(name: string): Promise<boolean>;
  prepareExpression(name: string): Promise<boolean>;
  isCurrentExpression(name: string): boolean;
  refreshCurrentExpressionFadeIn(name: string, fadeInSeconds?: number): void;
  primeInitialFrame(frame: ThreeCharacterParameterFrame): void;
  setParameter(id: string, value: number, weight?: number): void;
  parameterRange(id: string): { readonly minimum: number; readonly maximum: number } | null;

  eyeBallPosition(): { readonly x: number; readonly y: number };
  setEyeBallPosition(x: number, y: number): void;
  forceEyeBallPosition(x: number, y: number): void;

  update(deltaSeconds: number, frame: ThreeCharacterParameterFrame): void;
  draw(
    mvp: Matrix4,
    framebuffer: WebGLFramebuffer | null,
    viewport: readonly [number, number, number, number],
    color: readonly [number, number, number, number],
    drawState?: ThreeCharacterDrawState,
  ): void;

  /** Optional renderer-profile extensions; unsupported models simply ignore them. */
  setRendererLighting?(state: ThreeRendererLightState): void;
  loadRendererMultiplyTexture?(source: string, options: ThreeRendererMultiplyTextureOptions): Promise<void>;
  clearRendererMultiplyTexture?(): void;

  release(): void;
}

export const isThreeStoryCharacterModel = (value: unknown): value is ThreeStoryCharacterModel => {
  const model = value as Partial<ThreeStoryCharacterModel> | null;
  if (!model) return false;
  const requiredMethods: readonly (keyof ThreeStoryCharacterModel)[] = [
    "setPaused",
    "setMotionSpeed",
    "setEyeBlinkEnabled",
    "resetExpressionParametersToDefault",
    "hasMotion",
    "stopMotions",
    "drawableBounds",
    "canvasBounds",
    "resetMotionSync",
    "playMotion",
    "playExpression",
    "prepareMotion",
    "prepareExpression",
    "isCurrentExpression",
    "refreshCurrentExpressionFadeIn",
    "primeInitialFrame",
    "setParameter",
    "parameterRange",
    "eyeBallPosition",
    "setEyeBallPosition",
    "forceEyeBallPosition",
    "update",
    "draw",
    "release",
  ];
  return (
    typeof model.format === "string" &&
    typeof model.modelUrl === "string" &&
    typeof model.pixelsPerUnit === "number" &&
    typeof model.isOperational === "boolean" &&
    requiredMethods.every((method) => typeof model[method] === "function")
  );
};
