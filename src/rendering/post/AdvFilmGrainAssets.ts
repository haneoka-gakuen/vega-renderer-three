export const ADV_FILM_GRAIN_ASSET_SCHEMA = "haneoka.vega.renderer-asset/v1" as const;
export const ADV_FILM_GRAIN_ASSET_PREFIX = "haneoka.renderer-three/film-grain" as const;

export const ADV_FILM_GRAIN_PRESET_NAMES = [
  "thin-1",
  "thin-2",
  "medium-1",
  "medium-2",
  "medium-3",
  "medium-4",
  "medium-5",
  "medium-6",
  "large-1",
  "large-2",
] as const;

export type AdvBuiltinFilmGrainType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type AdvFilmGrainPresetName = (typeof ADV_FILM_GRAIN_PRESET_NAMES)[number];

/**
 * Stable request passed to the host-owned post-texture resolver.
 *
 * The key identifies a semantic slot, not a file path. A host may map it to
 * an authorized texture from any source. Vega Renderer Three never bundles
 * or assumes redistribution rights for that texture.
 */
export interface AdvBuiltinFilmGrainAssetRequest {
  readonly kind: "vega-renderer-asset";
  readonly assetKey: `${typeof ADV_FILM_GRAIN_ASSET_PREFIX}/${AdvBuiltinFilmGrainType}`;
  readonly metadata: {
    readonly schema: typeof ADV_FILM_GRAIN_ASSET_SCHEMA;
    readonly usage: "film-grain";
    readonly builtinType: AdvBuiltinFilmGrainType;
    readonly preset: AdvFilmGrainPresetName;
    readonly sampledChannel: "alpha";
  };
}

const BUILTIN_FILM_GRAIN_REQUESTS = Object.freeze(
  ADV_FILM_GRAIN_PRESET_NAMES.map((preset, builtinType): AdvBuiltinFilmGrainAssetRequest =>
    Object.freeze({
      kind: "vega-renderer-asset",
      assetKey: `${ADV_FILM_GRAIN_ASSET_PREFIX}/${builtinType}` as AdvBuiltinFilmGrainAssetRequest["assetKey"],
      metadata: Object.freeze({
        schema: ADV_FILM_GRAIN_ASSET_SCHEMA,
        usage: "film-grain",
        builtinType: builtinType as AdvBuiltinFilmGrainType,
        preset,
        sampledChannel: "alpha",
      }),
    }),
  ),
);

export const advBuiltinFilmGrainAssetRequest = (type: number): AdvBuiltinFilmGrainAssetRequest | null => {
  const index = Math.trunc(Number(type));
  return index >= 0 && index < BUILTIN_FILM_GRAIN_REQUESTS.length ? BUILTIN_FILM_GRAIN_REQUESTS[index]! : null;
};

/**
 * Built-in slots resolve through stable host keys; type 10 retains the
 * serialized custom texture reference without wrapping or rewriting it.
 */
export const advFilmGrainTextureReference = <CustomReference>(
  type: number,
  customTextureReference: CustomReference,
): AdvBuiltinFilmGrainAssetRequest | NonNullable<CustomReference> | null => {
  const index = Math.trunc(Number(type));
  if (index === 10) {
    return (customTextureReference ?? null) as NonNullable<CustomReference> | null;
  }
  return advBuiltinFilmGrainAssetRequest(index);
};

export interface AdvFilmGrainTexturePlan {
  readonly reference: unknown | null;
  readonly builtinRequest: AdvBuiltinFilmGrainAssetRequest | null;
  /**
   * Built-in and unknown legacy slots preserve the procedural implementation
   * when a host does not provide a texture. Custom slot 10 does not.
   */
  readonly proceduralFallback: boolean;
}

export const planAdvFilmGrainTexture = (type: number, customTextureReference: unknown): AdvFilmGrainTexturePlan => {
  const index = Math.trunc(Number(type));
  const builtinRequest = advBuiltinFilmGrainAssetRequest(index);
  return Object.freeze({
    reference: index === 10 ? (customTextureReference ?? null) : builtinRequest,
    builtinRequest,
    proceduralFallback: index !== 10,
  });
};

export interface AdvFilmGrainTextureBinding<TextureValue> {
  readonly reference: unknown | null;
  readonly texture: TextureValue | null;
  readonly activeWhenRequested: boolean;
  readonly usesProceduralFallback: boolean;
}

/**
 * Resolve the plan through the actual host service used by the post pass.
 * This pure boundary keeps hit/fallback behavior independently testable.
 */
export const resolveAdvFilmGrainTextureBinding = <TextureValue>(
  type: number,
  customTextureReference: unknown,
  resolve: (reference: unknown) => TextureValue | null,
): AdvFilmGrainTextureBinding<TextureValue> => {
  const plan = planAdvFilmGrainTexture(type, customTextureReference);
  const texture = plan.reference === null ? null : resolve(plan.reference);
  return Object.freeze({
    reference: plan.reference,
    texture,
    activeWhenRequested: plan.proceduralFallback || texture !== null,
    usesProceduralFallback: plan.proceduralFallback && texture === null,
  });
};

export const isAdvBuiltinFilmGrainAssetRequest = (value: unknown): value is AdvBuiltinFilmGrainAssetRequest => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AdvBuiltinFilmGrainAssetRequest>;
  return (
    candidate.kind === "vega-renderer-asset" &&
    typeof candidate.assetKey === "string" &&
    candidate.metadata?.schema === ADV_FILM_GRAIN_ASSET_SCHEMA &&
    candidate.metadata.usage === "film-grain" &&
    advBuiltinFilmGrainAssetRequest(candidate.metadata.builtinType ?? -1)?.assetKey === candidate.assetKey
  );
};
