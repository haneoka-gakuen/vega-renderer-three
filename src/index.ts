import {
  defineVegaPlugin,
  type StorySceneBackend,
  type StorySceneBackendContext,
  type VegaPlugin,
} from "@haneoka/vega";
import {
  LEGACY_HANEOKA_THREE_RENDERER_ID,
  ThreeStoryScene,
  VEGA_THREE_RENDERER_ID,
  type ThreeRendererEffectTarget,
  type ThreeRendererContext,
  type ThreeStorySceneOptions,
} from "./rendering/three/ThreeStoryScene";
import {
  THREE_POST_TEXTURE_RESOLVER,
  createThreePostTextureUrlResolver,
  type ThreePostTextureAssetUrlMap,
  type ThreePostTextureResolver,
} from "./rendering/PostTextureResolver";

export {
  LEGACY_HANEOKA_THREE_RENDERER_ID,
  ThreeStoryScene,
  VEGA_THREE_RENDERER_ID,
  type ThreeRendererEffectTarget,
  type ThreeRendererContext,
  type ThreeStorySceneOptions,
} from "./rendering/three/ThreeStoryScene";
export {
  isThreeStoryCharacterModel,
  type ThreeCharacterBounds,
  type ThreeCharacterDrawState,
  type ThreeCharacterMotionSyncStatus,
  type ThreeCharacterParameterBlend,
  type ThreeCharacterParameterFrame,
  type ThreeRendererAdditionalLight,
  type ThreeRendererLightState,
  type ThreeRendererMultiplyTextureOptions,
  type ThreeRendererSphericalHarmonics,
  type ThreeRendererVec3,
  type ThreeRendererVec4,
  type ThreeStoryCharacterModel,
} from "./rendering/ThreeCharacterModel";
export {
  StaticPortraitModel,
  type StaticPortraitModelOptions,
  type StaticPortraitPivot,
} from "./rendering/portrait/StaticPortraitModel";
export {
  THREE_POST_TEXTURE_RESOLVER,
  ThreePostTextureUrlResolver,
  createThreePostTextureUrlResolver,
  type ThreePostTextureAssetUrlMap,
  type ThreePostTextureLoader,
  type ThreePostTextureReference,
  type ThreePostTextureResolver,
  type ThreePostTextureUrlResolverOptions,
} from "./rendering/PostTextureResolver";
export * from "./rendering/post/AdvFilmGrainAssets";
export {
  AdvPostPipeline,
  type AdvCharacterFramebuffer,
  type AdvCharacterGroupSettings,
  type AdvPostPipelineOptions,
  type AdvPostBeginOptions,
  type AdvPostFinishOptions,
  type AdvSceneLayer,
} from "./rendering/three/AdvPostPipeline";
export {
  detectAdvFieldTargetFormat,
  selectAdvFieldTargetFormat,
  supportsRenderableRgba16Unorm,
  type AdvFieldTargetFormat,
  type AdvFieldTargetPrecision,
} from "./rendering/three/AdvFieldTargetFormat";
export {
  computeAdvCharacterHeadWorldPosition,
  computeAdvLookTarget,
} from "./rendering/three/AdvLookTarget";
export {
  createUnityAdvViewport,
  FULL_UNITY_VIEWPORT,
  unityAdvOrientedTargetAspect,
  unityAdvTargetAspect,
  type UnityNormalizedViewport,
} from "./rendering/three/UnityAdvViewport";
export { UnityTargetFrameClock } from "./rendering/three/UnityTargetFrameClock";
export * from "./rendering/three/UnityTransform";
export * from "./rendering/three/PendingCharacterCommands";
export { AdvRainFrameRenderer } from "./rendering/three/AdvRainFrameRenderer";
export {
  videoAbortError,
  waitForVideo,
} from "./rendering/three/AdvVideoWait";
export { StoryDomOverlay } from "./rendering/three/StoryDomOverlay";
export * from "./rendering/three/SharedTextureResourceCache";
export * from "./rendering/three/StorySceneSnapshot";
export * from "./rendering/three/transitions/AdvRuleTransition";
export * from "./rendering/three/transitions/AdvRuleTransitionPass";
export type { AdvColorGradingPipelineMode } from "./rendering/post/AdvUrpPostProcessor";

export interface ThreeRendererPluginOptions extends ThreeStorySceneOptions {
  readonly contributionId?: string;
  readonly contributionName?: string;
  readonly backend?:
    | typeof VEGA_THREE_RENDERER_ID
    | typeof LEGACY_HANEOKA_THREE_RENDERER_ID;
  /**
   * Plugin-scoped resolver registered as a typed Vega service. If it exposes
   * `dispose`, the plugin lifetime owns it.
   */
  readonly postTextureResolver?: ThreePostTextureResolver;
  /**
   * Convenience path for authorized host assets. Keys such as
   * `haneoka.renderer-three/film-grain/0` are loaded, cached, and released by
   * the plugin without bundling their textures here.
   */
  readonly postTextureAssets?: ThreePostTextureAssetUrlMap;
}

export const createThreeStorySceneBackend = (
  context: StorySceneBackendContext,
  options: ThreeStorySceneOptions = {},
): StorySceneBackend => new ThreeStoryScene(context, options);

export const createThreeRendererPlugin = (
  options: ThreeRendererPluginOptions = {},
): VegaPlugin => {
  if (options.postTextureResolver && options.postTextureAssets) {
    throw new TypeError(
      "Choose postTextureResolver or postTextureAssets, not both",
    );
  }
  return defineVegaPlugin({
    manifest: {
      id: "haneoka.renderer-three",
      name: "Vega Three Renderer",
      version: "0.1.0",
      apiVersion: 1,
      description: "Command-complete Three.js WebGL2 renderer for Vega",
      capabilities: ["render"],
    },
    setup(context) {
      const postTextureResolver =
        options.postTextureResolver ??
        (options.postTextureAssets
          ? createThreePostTextureUrlResolver({
              assetUrls: options.postTextureAssets,
            })
          : undefined);
      if (postTextureResolver) {
        context.provide(
          THREE_POST_TEXTURE_RESOLVER,
          postTextureResolver,
        );
        if (postTextureResolver.dispose) {
          context.lifetime.defer(() =>
            postTextureResolver.dispose?.(),
          );
        }
      }
      context.contribute("render", {
        id: options.contributionId ?? "haneoka.renderer-three",
        name: options.contributionName ?? "Vega Three WebGL2",
        backend: options.backend ?? VEGA_THREE_RENDERER_ID,
        create: (sceneContext, signal) =>
          createThreeStorySceneBackend(
            { ...sceneContext, signal },
            {
              ...options,
              rendererId: options.rendererId ?? options.backend,
            },
          ),
      });
    },
  });
};

export default createThreeRendererPlugin;
