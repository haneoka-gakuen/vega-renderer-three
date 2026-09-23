import type { StoryScreenEffectSnapshot } from "@haneoka/vega/renderer-kit";
import type { AdvRainFrameSnapshot } from "./AdvRainFrameRenderer";
import type { CanvasStillSnapshot } from "./AdvCanvasPass";
import type {
  AdvBackgroundEntry,
  AdvEffectEntry,
  AdvFrameEntry,
  AdvPlayerState,
  AdvStillEntry,
  AdvStorySceneSeekSnapshot as PortableAdvStorySceneSeekSnapshot,
} from "@haneoka/vega/renderer-kit";
import type { PendingCharacterCommandsSnapshot } from "./PendingCharacterCommands";
import type { FieldRendererState, LipSyncState, StoryCameraState, StoryCharacterEntry, Vec3 } from "./StorySceneTypes";

export const STORY_SCENE_SEEK_SNAPSHOT_VERSION = 1 as const;

export interface AdvCharacterPresentationEvent {
  readonly kind: "motion" | "expression";
  readonly name: string;
}

export interface AdvSeekCharacterSnapshot {
  readonly target: string;
  readonly identity: string;
  readonly characterKey: string;
  readonly controllerIdentity: string;
  readonly visible: boolean;
  readonly speculative: boolean;
  /** Immutable episode resource record. */
  readonly entry: StoryCharacterEntry;
  readonly positionType: number;
  readonly worldPosition: Vec3 | null;
  readonly offset: Vec3;
  readonly modelState?: unknown;
  readonly alpha: number;
  readonly brightness: number;
  readonly facing: 1 | -1;
  readonly roleAngle: number;
  readonly angle: number;
  readonly bodyAngle: number;
  readonly angleOverride: boolean;
  readonly lookX: number;
  readonly lookY: number;
  readonly lookOriginalX: number;
  readonly lookOriginalY: number;
  readonly lookOverride: boolean;
  readonly blurIntensity: number;
  readonly sortingOrder: number;
  readonly rimLight: {
    readonly enabled: boolean;
    readonly color: { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
    readonly shadowIntensity: number;
  };
  /**
   * Presentation calls since CharacterIn, in authored order. Replaying these
   * with zero fade restores the same frozen provider queues produced by
   * deterministic command replay without serializing SDK internals.
   */
  readonly presentation: readonly AdvCharacterPresentationEvent[];
  readonly currentMotionName: string;
  readonly currentMotionFadeInSeconds?: number;
  readonly currentExpressionName: string;
  readonly currentExpressionFadeInSeconds?: number;
  readonly activeExpressionName: string;
  readonly activeExpressionFadeInSeconds?: number;
  readonly pendingPausedMotion: {
    readonly name: string;
    readonly fadeInSeconds?: number;
  } | null;
  readonly pendingPausedExpression: {
    readonly name: string;
    readonly fadeInSeconds?: number;
  } | null;
  /** Voice analyzers/PCM are forbidden by the snapshot safety proof. */
  readonly lipSync: Omit<LipSyncState, "sources" | "motionSyncPcm"> & {
    readonly sources: readonly [];
    readonly motionSyncPcm: null;
  };
  readonly paused: boolean;
}

export interface AdvStorySceneSeekSnapshot extends PortableAdvStorySceneSeekSnapshot {
  readonly version: typeof STORY_SCENE_SEEK_SNAPSHOT_VERSION;
  readonly rendererState: {
    readonly kind: "three";
    readonly version: 3;
    readonly transforms: readonly {
      readonly target: string;
      readonly current: Readonly<Record<string, number>>;
      readonly planned: Readonly<Record<string, number>>;
    }[];
  };
  readonly background: AdvBackgroundEntry | null;
  readonly still: AdvStillEntry | null;
  readonly stillAlpha: number;
  readonly stillBackgroundAlpha: number;
  readonly stillOverlayAlpha: number;
  readonly stillAnimationIndex: number;
  readonly frame: AdvFrameEntry | null;
  readonly frameName: string;
  readonly frameOpacity: number;
  readonly frameSlide: number;
  readonly frameEntries: AdvPlayerState["frameEntries"];
  readonly frameParticles?: Readonly<Record<string, AdvRainFrameSnapshot>>;
  readonly stillLayers?: readonly CanvasStillSnapshot[];
  readonly stage: unknown;
  readonly screenEffects?: readonly StoryScreenEffectSnapshot[];
  readonly screenFilterState?: readonly { readonly target: string; readonly state: unknown }[];
  readonly stageEnv: AdvPlayerState["stageEnv"];
  readonly stageOffsets: readonly (readonly [number, Vec3])[];
  readonly cameraState: StoryCameraState;
  readonly cameraShake: {
    readonly enabled: boolean;
    readonly strength: number;
    readonly cycleSeconds: number;
    readonly vibrato: number;
    readonly randomness: number;
  };
  readonly fieldRendererState: FieldRendererState;
  readonly postEffect: unknown;
  readonly commandVolumes: readonly {
    readonly key: string;
    readonly profile: unknown;
    readonly weight: number;
    readonly enabled: boolean;
  }[];
  readonly commandEffects: readonly {
    readonly key: string;
    readonly effect: AdvEffectEntry;
    readonly atOnce: boolean;
    readonly simulationSpeed: number;
    readonly positionType?: number;
    readonly targetName: string;
    readonly canvasLayers: readonly unknown[];
  }[];
  readonly effect: AdvPlayerState["effect"];
  readonly effects: AdvPlayerState["effects"];
  readonly cover: AdvPlayerState["cover"];
  readonly talk: AdvPlayerState["talk"];
  readonly title: AdvPlayerState["title"];
  readonly location: AdvPlayerState["location"];
  readonly subtitles: AdvPlayerState["subtitles"];
  readonly chat: AdvPlayerState["chat"];
  readonly choices: AdvPlayerState["choices"];
  readonly dofActive: boolean;
  readonly characters: readonly AdvSeekCharacterSnapshot[];
  readonly lifecycle: {
    readonly characterLoadSequence: number;
    readonly characterLoadTokens: readonly (readonly [string, number])[];
    readonly characterControllerIdentities: readonly (readonly [string, string])[];
    readonly pendingCharacters: PendingCharacterCommandsSnapshot;
    readonly characterPriorityOrder: readonly number[];
  };
}

export const isDetailedThreeStorySceneSeekSnapshot = (
  value: PortableAdvStorySceneSeekSnapshot,
): value is AdvStorySceneSeekSnapshot => {
  const candidate = value as Partial<AdvStorySceneSeekSnapshot>;
  return Boolean(
    candidate.rendererState?.kind === "three" &&
    candidate.rendererState.version === 3 &&
    Array.isArray(candidate.rendererState.transforms) &&
    candidate.lifecycle &&
    Array.isArray(candidate.lifecycle.characterLoadTokens) &&
    Array.isArray(candidate.characters) &&
    candidate.characters.every(
      (character) => typeof character.identity === "string" && typeof character.controllerIdentity === "string",
    ),
  );
};

export interface SeekSnapshotSafety {
  readonly safe: boolean;
  readonly reason?: string;
}
