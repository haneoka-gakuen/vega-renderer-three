import type { StoryRendererServiceKey } from "@haneoka/vega/renderer-kit";
import { LinearFilter, NoColorSpace, Texture, TextureLoader } from "three";
import type { AdvPostTextureUsage } from "./post/AdvUrpUberPost";
import { advFilmGrainTextureReference, isAdvBuiltinFilmGrainAssetRequest } from "./post/AdvFilmGrainAssets";

/**
 * Opaque project reference or a typed renderer-asset request such as
 * `AdvBuiltinFilmGrainAssetRequest`.
 */
export type ThreePostTextureReference = unknown;

export interface ThreePostTextureResolver {
  resolve(reference: ThreePostTextureReference, usage: AdvPostTextureUsage): Texture | null;
  dispose?(): void;
  preload?(references: readonly PostTextureRequest[], signal?: AbortSignal): Promise<void>;
}

export interface PostTextureRequest {
  readonly reference: unknown;
  readonly usage: AdvPostTextureUsage;
}

export function storyPostTextureRequests(story: unknown): PostTextureRequest[] {
  const seen = new Set<object>();
  const requests = new Map<unknown, AdvPostTextureUsage>();
  const visit = (value: unknown, key = ""): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const component = value as Record<string, unknown>;
    const name = String(component.name || key)
      .split(".")
      .pop();
    const fields = component.fields as Record<string, { value?: unknown }> | undefined;
    if (fields && component.active !== false) {
      let reference: unknown;
      let usage: AdvPostTextureUsage | undefined;
      if (name === "FilmGrain") {
        reference = advFilmGrainTextureReference(Number(fields.type?.value ?? 0), fields.texture?.value);
        usage = "film-grain";
      } else if (name === "ColorLookup") {
        reference = fields.texture?.value;
        usage = "color-lookup";
      } else if (name === "Bloom") {
        reference = fields.dirtTexture?.value;
        usage = "lens-dirt";
      }
      if (reference != null && usage) requests.set(reference, usage);
    }
    for (const [childKey, child] of Object.entries(component)) visit(child, childKey);
  };
  visit(story);
  return [...requests].map(([reference, usage]) => ({ reference, usage }));
}

export type ThreePostTextureAssetUrlMap = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

export interface ThreePostTextureLoader {
  load(
    url: string,
    onLoad?: (texture: Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): Texture;
}

export interface ThreePostTextureUrlResolverOptions {
  /** Authorized URLs keyed by stable renderer asset key. */
  readonly assetUrls: ThreePostTextureAssetUrlMap;
  /**
   * Optional project-reference mapper. A non-empty string reference is used
   * directly when this hook is absent, preserving custom texture type 10.
   */
  readonly resolveUrl?: (reference: unknown, usage: AdvPostTextureUsage) => string | null;
  /** Injectable for tests or a host-owned Three loading manager. */
  readonly loader?: ThreePostTextureLoader;
}

interface PostTextureCacheEntry {
  texture: Texture | null;
  state: "loading" | "ready" | "failed";
  ready: Promise<void>;
  settle(): void;
}

const mappedAssetUrl = (assets: ThreePostTextureAssetUrlMap, key: string): string | null => {
  const value =
    typeof (assets as ReadonlyMap<string, string>).get === "function"
      ? (assets as ReadonlyMap<string, string>).get(key)
      : Object.hasOwn(assets, key)
        ? (assets as Readonly<Record<string, string>>)[key]
        : undefined;
  return typeof value === "string" && value.trim() ? value : null;
};

/**
 * Host-ready resolver for stable asset keys and custom URLs.
 *
 * Loading remains asynchronous internally, while the renderer-facing service
 * stays synchronous: a pending or failed texture returns `null`, allowing the
 * post pass to use its procedural fallback until a later frame observes the
 * ready cached texture.
 */
export class ThreePostTextureUrlResolver implements ThreePostTextureResolver {
  private readonly assetUrls: ThreePostTextureAssetUrlMap;
  private readonly resolveUrlHook: ThreePostTextureUrlResolverOptions["resolveUrl"] | undefined;
  private readonly loader: ThreePostTextureLoader;
  private readonly entries = new Map<string, PostTextureCacheEntry>();
  private readonly disposedTextures = new WeakSet<Texture>();
  private disposed = false;

  constructor(options: ThreePostTextureUrlResolverOptions) {
    this.assetUrls = options.assetUrls;
    this.resolveUrlHook = options.resolveUrl;
    this.loader = options.loader ?? new TextureLoader();
  }

  resolve(reference: ThreePostTextureReference, usage: AdvPostTextureUsage): Texture | null {
    if (this.disposed) return null;
    if (reference instanceof Texture) return reference;
    const url = this.urlFor(reference, usage);
    if (!url) return null;
    const cached = this.entries.get(url);
    if (cached) return cached.state === "ready" ? cached.texture : null;

    let settle = () => {};
    const ready = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: PostTextureCacheEntry = {
      texture: null,
      state: "loading",
      ready,
      settle,
    };
    this.entries.set(url, entry);
    try {
      const texture = this.loader.load(
        url,
        (loaded) => {
          if (this.disposed || this.entries.get(url) !== entry) {
            this.disposeTexture(loaded);
            return;
          }
          entry.texture = loaded;
          entry.state = "ready";
          this.configureTexture(loaded);
          entry.settle();
        },
        undefined,
        () => {
          if (this.entries.get(url) !== entry) return;
          entry.state = "failed";
          if (entry.texture) this.disposeTexture(entry.texture);
          entry.settle();
        },
      );
      entry.texture ??= texture;
      if (entry.state === "failed") this.disposeTexture(texture);
    } catch {
      entry.state = "failed";
      entry.settle();
      if (entry.texture) this.disposeTexture(entry.texture);
    }
    return entry.state === "ready" ? entry.texture : null;
  }

  async preload(references: readonly PostTextureRequest[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const work = Promise.all(
      references.map(async ({ reference, usage }) => {
        this.resolve(reference, usage);
        const url = this.urlFor(reference, usage);
        const entry = url ? this.entries.get(url) : undefined;
        if (!entry) return;
        await entry.ready;
        if (entry.state === "failed") throw new Error(`Could not load post-process texture: ${url}`);
      }),
    );
    if (!signal) {
      await work;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      work.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.state = "failed";
      entry.settle();
      if (entry.texture) this.disposeTexture(entry.texture);
    }
    this.entries.clear();
  }

  private urlFor(reference: ThreePostTextureReference, usage: AdvPostTextureUsage): string | null {
    if (isAdvBuiltinFilmGrainAssetRequest(reference)) {
      return mappedAssetUrl(this.assetUrls, reference.assetKey);
    }
    if (reference && typeof reference === "object") {
      const value = reference as Record<string, unknown>;
      const metadata =
        value.reference && typeof value.reference === "object" ? (value.reference as Record<string, unknown>) : value;
      for (const key of [metadata.assetKey, metadata.name, metadata.pathId]) {
        if (typeof key !== "string") continue;
        const url = mappedAssetUrl(this.assetUrls, key);
        if (url) return url;
      }
    }
    const mapped = typeof reference === "string" ? mappedAssetUrl(this.assetUrls, reference) : null;
    if (mapped) return mapped;
    const resolved = this.resolveUrlHook?.(reference, usage);
    if (typeof resolved === "string" && resolved.trim()) return resolved;
    return typeof reference === "string" && reference.trim() ? reference : null;
  }

  private configureTexture(texture: Texture): void {
    texture.colorSpace = NoColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
  }

  private disposeTexture(texture: Texture): void {
    if (this.disposedTextures.has(texture)) return;
    this.disposedTextures.add(texture);
    texture.dispose();
  }
}

export const createThreePostTextureUrlResolver = (
  options: ThreePostTextureUrlResolverOptions,
): ThreePostTextureUrlResolver => new ThreePostTextureUrlResolver(options);

/**
 * Optional renderer service for host- or plugin-owned post-process textures.
 * Built-in film-grain slots arrive as stable asset-key requests; custom slots
 * retain their serialized reference. Returned textures remain owned by the
 * service.
 */
export const THREE_POST_TEXTURE_RESOLVER: StoryRendererServiceKey<ThreePostTextureResolver> = Object.freeze({
  id: "haneoka.renderer-three.post-texture-resolver",
});
