import {
  AddEquation,
  Color,
  CustomBlending,
  DoubleSide,
  Group,
  Matrix3,
  Mesh,
  NormalBlending,
  NoColorSpace,
  OneFactor,
  OrthographicCamera,
  SrcAlphaFactor,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  Texture,
  Vector2,
  Vector4,
  VideoTexture,
  type WebGLRenderer,
} from "three";
import {
  computeAdvFrameBandLayout,
  resolveStoryFrameLayout,
  StoryStillAnimator,
  type AdvStillEntry,
  type StoryStillPresentation,
  type StoryStillAnimationSnapshot,
  type AdvFrameEntry,
  type StoryFrameLayout,
  type StoryFrameLayoutProvider,
  type StoryFrameNode,
} from "@haneoka/vega/renderer-kit";
import { AdvRainFrameRenderer, type AdvRainFrameSnapshot } from "./AdvRainFrameRenderer";
import { NativeFrameAnimator } from "./NativeFrameAnimation";

export interface CanvasTextureLease {
  readonly value: Texture;
  release(): void;
}
export type CanvasTextureLoader = (source: string) => Promise<CanvasTextureLease>;
const vertex = `precision highp float;
attribute vec3 position; attribute vec2 uv;
uniform vec2 uViewport; uniform vec4 uRect; uniform vec4 uCrop; uniform vec2 uOffset;
uniform mat3 uTransform;
varying vec2 vUv;
void main(){ vec2 p=(uTransform*vec3(uRect.xy+vec2(position.x+0.5,0.5-position.y)*uRect.zw,1.0)).xy+uOffset;
gl_Position=vec4(2.0*p.x/uViewport.x-1.0,1.0-2.0*p.y/uViewport.y,0.0,1.0);
vUv=uCrop.xy+uv*uCrop.zw; }`;
const fragment = `precision highp float;
uniform sampler2D uTexture; uniform vec4 uColor; uniform int uTextured; varying vec2 vUv;
void main(){gl_FragColor=uColor;if(uTextured!=0)gl_FragColor*=texture2D(uTexture,vUv);}`;
const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const alpha = (value: unknown): number => Math.max(0, Math.min(1, finite(value)));
interface ImageView {
  readonly mesh: Mesh<PlaneGeometry, RawShaderMaterial>;
  readonly rect: Vector4;
  readonly crop: Vector4;
  readonly offset: Vector2;
  readonly color: Vector4;
  readonly transform: Matrix3;
  node?: StoryFrameNode;
  opacityFactor: number;
  lease?: CanvasTextureLease;
  source: string;
  leaseSource: string;
  generation: number;
  fit: "cover" | "contain" | "stretch";
}
interface FrameView {
  readonly frame: AdvFrameEntry;
  readonly group: Group;
  readonly images: ImageView[];
  readonly releases: (() => void)[];
  rain?: AdvRainFrameRenderer;
  layout?: StoryFrameLayout;
  opacity: number;
  slide: number;
  disposed: boolean;
  still?: AdvStillEntry;
  animator?: StoryStillAnimator;
  frameAnimator?: NativeFrameAnimator;
  ready?: Promise<FrameView>;
  operation: number;
  elapsed: number;
}
export interface CanvasStillSnapshot {
  readonly key: string;
  readonly still: AdvStillEntry;
  readonly visible: boolean;
  readonly opacity: number;
  readonly animation?: StoryStillAnimationSnapshot;
}

export class AdvCanvasPass {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly viewport = new Vector2(1, 1);
  private readonly views = new Set<ImageView>();
  private readonly frames = new Map<string, FrameView>();
  private readonly stills = new Map<string, FrameView>();
  private readonly pending = new Set<FrameView>();
  private readonly video: ImageView;
  private readonly videoBackground: ImageView;
  private readonly stillBackground: ImageView;
  private readonly still: ImageView;
  private readonly stillShade: ImageView;
  private readonly flash: ImageView;
  private readonly cover: ImageView;
  private videoTexture: VideoTexture | undefined;
  private videoLayout: import("@haneoka/vega/renderer-kit").StoryVideoLayout | undefined;
  private paused = false;
  private disposed = false;
  private offsetX = 0;
  private offsetY = 0;
  private stillOffsetX = 0;
  private stillOffsetY = 0;
  private stillSpeed = 1;
  get ready(): boolean {
    return this.pending.size === 0;
  }

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly loadTexture: CanvasTextureLoader,
    private readonly layouts?: StoryFrameLayoutProvider,
  ) {
    this.scene.matrixAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
    this.videoBackground = this.image(27);
    this.video = this.image(28);
    this.stillBackground = this.image(30);
    this.still = this.image(31);
    this.stillShade = this.image(32);
    this.flash = this.image(55);
    this.cover = this.image(56);
    this.setColor(this.stillBackground, "#000000");
    this.setColor(this.stillShade, "#000000");
    this.setColor(this.flash, "#ffffff");
    this.setColor(this.cover, "#000000");
  }
  private image(order: number, parent: Scene | Group = this.scene): ImageView {
    const rect = new Vector4(0, 0, this.viewport.x, this.viewport.y),
      crop = new Vector4(0, 0, 1, 1);
    const offset = new Vector2(this.offsetX, this.offsetY),
      color = new Vector4(1, 1, 1, 0);
    const transform = new Matrix3();
    const material = new RawShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uViewport: { value: this.viewport },
        uRect: { value: rect },
        uCrop: { value: crop },
        uOffset: { value: offset },
        uColor: { value: color },
        uTexture: { value: null },
        uTextured: { value: 0 },
        uTransform: { value: transform },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
      toneMapped: false,
    });
    const mesh = new Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    parent.add(mesh);
    const view: ImageView = {
      mesh,
      rect,
      crop,
      offset,
      color,
      transform,
      opacityFactor: 1,
      source: "",
      leaseSource: "",
      generation: 0,
      fit: "cover",
    };
    this.views.add(view);
    return view;
  }
  private setColor(view: ImageView, value: string): void {
    const color = new Color(value).convertLinearToSRGB();
    view.color.set(color.r, color.g, color.b, view.color.w);
  }
  private opacity(view: ImageView, value: number): void {
    view.color.w = alpha(value) * view.opacityFactor;
    view.mesh.visible = view.color.w > 0;
  }
  private async source(view: ImageView, source: string): Promise<boolean> {
    if (view.source === source && view.leaseSource === source && view.lease) return true;
    const generation = ++view.generation;
    view.source = source;
    if (view.leaseSource === source && view.lease) return true;
    if (!source) {
      view.lease?.release();
      delete view.lease;
      view.leaseSource = "";
      view.mesh.material.uniforms.uTexture!.value = null;
      view.mesh.material.uniforms.uTextured!.value = 0;
      this.opacity(view, 0);
      return true;
    }
    let lease: CanvasTextureLease;
    try {
      lease = await this.loadTexture(source);
    } catch (error) {
      if (this.disposed || !this.views.has(view) || generation !== view.generation) return false;
      view.source = view.leaseSource;
      throw error;
    }
    if (this.disposed || !this.views.has(view) || generation !== view.generation) {
      lease.release();
      return false;
    }
    view.lease?.release();
    view.lease = lease;
    view.leaseSource = source;
    view.mesh.material.uniforms.uTexture!.value = lease.value;
    view.mesh.material.uniforms.uTextured!.value = 1;
    this.crop(view, lease.value);
    return true;
  }
  private crop(view: ImageView, texture: Texture): void {
    view.crop.set(0, 0, 1, 1);
    if (view.fit === "stretch") return;
    const source = texture.image as
      | { width?: number; height?: number; videoWidth?: number; videoHeight?: number }
      | undefined;
    const width = source?.videoWidth || source?.width || 1,
      height = source?.videoHeight || source?.height || 1;
    const visible = view.rect.z / Math.max(1, view.rect.w) / (width / height);
    if (view.fit === "contain") {
      const scale = Math.min(view.rect.z / width, view.rect.w / height);
      view.rect.set(
        view.rect.x + (view.rect.z - width * scale) / 2,
        view.rect.y + (view.rect.w - height * scale) / 2,
        width * scale,
        height * scale,
      );
      return;
    }
    if (visible < 1) view.crop.set((1 - visible) / 2, 0, visible, 1);
    else view.crop.set(0, (1 - 1 / visible) / 2, 1, 1 / visible);
  }
  async setStill(source: string, opacity: number): Promise<void> {
    if (await this.source(this.still, source)) this.opacity(this.still, source ? opacity : 0);
  }
  cancelStillLoad(): void {
    this.still.generation++;
    this.still.source = this.still.leaseSource;
  }
  setStillAlpha(value: number): void {
    this.opacity(this.still, this.still.lease ? value : 0);
    for (const key of this.visibleStillKeys) this.setStillOpacity(key, value);
  }
  private get lastVisibleStill(): FrameView | undefined {
    let result: FrameView | undefined;
    for (const entry of this.stills.values()) if (entry.group.visible) result = entry;
    return result;
  }
  get stillAlpha(): number {
    return this.lastVisibleStill?.opacity ?? this.still.color.w;
  }
  get stillBackgroundAlpha(): number {
    return this.stillBackground.color.w;
  }
  get stillOverlayAlpha(): number {
    return this.stillShade.color.w;
  }
  setStillViewAlpha(background: number, shade: number): void {
    this.opacity(this.stillBackground, background);
    this.opacity(this.stillShade, shade);
  }
  setFlash(value: number): void {
    this.opacity(this.flash, value);
  }
  setCover(color: string, value: number): void {
    this.setColor(this.cover, color);
    this.opacity(this.cover, value);
  }
  setVideo(video: HTMLVideoElement | null): void {
    this.videoTexture?.dispose();
    this.videoTexture = undefined;
    this.video.mesh.material.uniforms.uTexture!.value = null;
    this.video.mesh.material.uniforms.uTextured!.value = 0;
    this.opacity(this.video, 0);
    this.opacity(this.videoBackground, 0);
    if (!video) return;
    for (const [key, frame] of this.frames)
      if (finite(frame.frame.oneShotSeconds) > 0) this.setFrameOpacity(key, 0, frame.slide);
    const texture = new VideoTexture(video);
    texture.colorSpace = NoColorSpace;
    texture.needsUpdate = true;
    this.videoTexture = texture;
    this.video.mesh.material.uniforms.uTexture!.value = texture;
    this.video.mesh.material.uniforms.uTextured!.value = 1;
    this.applyVideoLayout();
  }
  setVideoLayout(layout?: import("@haneoka/vega/renderer-kit").StoryVideoLayout): void {
    this.videoLayout = layout;
    this.applyVideoLayout();
  }
  private applyVideoLayout(): void {
    const box = this.videoLayout?.viewport ?? [0, 0, 1, 1];
    this.video.rect.set(
      finite(box[0]) * this.viewport.x,
      finite(box[1]) * this.viewport.y,
      Math.max(0, finite(box[2], 1)) * this.viewport.x,
      Math.max(0, finite(box[3], 1)) * this.viewport.y,
    );
    this.videoBackground.rect.copy(this.video.rect);
    if (this.videoLayout?.background) this.setColor(this.videoBackground, this.videoLayout.background);
    this.opacity(this.videoBackground, this.videoLayout?.background && this.videoTexture ? this.video.color.w : 0);
    this.video.fit = this.videoLayout?.fit ?? "cover";
    if (this.videoTexture) this.crop(this.video, this.videoTexture);
  }
  setVideoAlpha(value: number): void {
    this.opacity(this.video, value);
    this.opacity(this.videoBackground, this.videoLayout?.background && this.videoTexture ? value : 0);
  }
  async setFrame(key: string, frame: AdvFrameEntry, value: number): Promise<void> {
    await this.createLayer(this.frames, key, frame, value);
  }
  private async createLayer(
    collection: Map<string, FrameView>,
    key: string,
    frame: AdvFrameEntry,
    value: number,
  ): Promise<FrameView> {
    this.clearLayers(collection, key);
    const entry: FrameView = {
      frame,
      group: new Group(),
      images: [],
      releases: [],
      opacity: alpha(value),
      slide: 0,
      disposed: false,
      operation: 0,
      elapsed: 0,
    };
    collection.set(key, entry);
    this.pending.add(entry);
    this.scene.add(entry.group);
    this.orderFrames();
    const kind = String(frame.type || frame.name || frame.source || "").toLowerCase();
    try {
      const authored = frame.layout;
      const layout =
        authored && typeof authored === "object" && "nodes" in authored && Array.isArray(authored.nodes)
          ? (authored as unknown as StoryFrameLayout)
          : this.layouts?.resolve(frame);
      if (layout) {
        entry.layout = layout;
        if (collection === this.frames && frame.animation)
          entry.frameAnimator = new NativeFrameAnimator(layout, frame.animation);
        const loads: Promise<boolean>[] = [];
        for (const node of layout.nodes) {
          if (!node.image) continue;
          const image = this.image(0, entry.group);
          image.node = node;
          image.fit = "stretch";
          image.color.set(...node.image.color);
          image.color.w = 0;
          entry.images.push(image);
          if (node.image.blend === "additive") {
            Object.assign(image.mesh.material, {
              blending: CustomBlending,
              blendEquation: AddEquation,
              blendSrc: SrcAlphaFactor,
              blendDst: OneFactor,
            });
          }
          const source =
            node.image.texture || (node.image.textureKey ? frame.textures?.[node.image.textureKey] : undefined);
          if (!source && (node.image.textureKey || node.image.texture))
            throw new Error(`Frame image texture is missing: ${node.id}`);
          if (source) loads.push(this.source(image, source));
        }
        await Promise.all(loads);
      } else if (kind.includes("rain")) {
        const texture = String(frame.texture || "");
        if (!texture) throw new Error("Rain frame requires a particle texture");
        const lease = await this.loadTexture(texture);
        if (entry.disposed) {
          lease.release();
          return entry;
        }
        entry.releases.push(() => lease.release());
        entry.rain = new AdvRainFrameRenderer(frame, lease.value);
        entry.rain.setPaused(this.paused);
        entry.rain.setOffset(this.offsetX, this.offsetY);
        entry.rain.setOpacity(entry.opacity);
        entry.group.add(entry.rain.mesh);
      } else if (kind.includes("letterbox") || kind.includes("cinema") || kind.includes("pillarbox")) {
        for (let index = 0; index < 2; index++) {
          const image = this.image(index, entry.group);
          this.setColor(image, frame.color || "#000000");
          this.opacity(image, entry.opacity);
          entry.images.push(image);
        }
      } else {
        const textures = frame.textures ? Object.values(frame.textures).filter(Boolean) : [];
        const source = frame.texture || textures[0] || frame.elements?.[0]?.texture || frame.edges?.[0]?.texture;
        const image = this.image(0, entry.group);
        entry.images.push(image);
        if (source) await this.source(image, source);
        else this.setColor(image, frame.color || "#000000");
        if (!entry.disposed) this.opacity(image, entry.opacity);
      }
      if (!entry.disposed) {
        if (entry.frameAnimator) entry.layout = entry.frameAnimator.sample(0);
        this.layoutFrame(entry);
        this.orderFrames();
      }
      return entry;
    } catch (error) {
      if (entry.disposed) return entry;
      if (collection.get(key) === entry) this.clearLayers(collection, key);
      throw error;
    } finally {
      this.pending.delete(entry);
    }
  }
  setFrameOpacity(key: string, value: number, slide: number): void {
    const entry = this.frames.get(key);
    if (!entry) return;
    entry.opacity = alpha(value);
    entry.slide = finite(slide);
    for (const image of entry.images) this.opacity(image, entry.opacity);
    entry.rain?.setOpacity(entry.opacity);
    this.layoutFrame(entry);
  }
  private layoutFrame(entry: FrameView): void {
    const { x: width, y: height } = this.viewport,
      kind = String(entry.frame.type || "").toLowerCase();
    entry.rain?.setViewport(width, height);
    if (entry.layout) {
      const placements = new Map(
        resolveStoryFrameLayout(entry.layout, width, height).map((placement) => [placement.node.id, placement]),
      );
      for (const image of entry.images) {
        const placement = placements.get(image.node!.id)!;
        let w = placement.width,
          h = placement.height;
        const source = image.lease?.value.image as { width?: number; height?: number } | undefined;
        if (image.node?.image?.preserveAspect && source?.width && source.height) {
          const ratio = source.width / source.height;
          if (w / h > ratio) w = h * ratio;
          else h = w / ratio;
        }
        const [a, b, c, d, x, y] = placement.transform;
        image.transform.set(a, c, x, b, d, y, 0, 0, 1);
        image.rect.set(-placement.node.pivot[0] * w, -(1 - placement.node.pivot[1]) * h, w, h);
        const tint = placement.node.image?.color;
        if (tint) image.color.set(tint[0], tint[1], tint[2], image.color.w);
        image.opacityFactor = placement.opacity * (tint?.[3] ?? 1);
        this.opacity(image, entry.opacity);
      }
    } else if (kind.includes("letterbox") || kind.includes("cinema")) {
      const layout = computeAdvFrameBandLayout(entry.frame, width, entry.slide);
      entry.images[0]?.rect.set(0, layout.topOffset, width, layout.bandHeight);
      entry.images[1]?.rect.set(0, height - layout.bandHeight + layout.bottomOffset, width, layout.bandHeight);
    } else if (kind.includes("pillarbox")) {
      const band = (finite(entry.frame.bandWidth, 400) * width) / Math.max(1, finite(entry.frame.referenceWidth, 1920));
      entry.images[0]?.rect.set(0, 0, band, height);
      entry.images[1]?.rect.set(width - band, 0, band, height);
    } else
      for (const image of entry.images) {
        image.rect.set(0, 0, width, height);
        if (image.lease) this.crop(image, image.lease.value);
      }
  }
  private orderFrames(): void {
    for (const [collection, base] of [
      [this.stills, 31],
      [this.frames, 50],
    ] as const) {
      let order = base;
      for (const entry of collection.values()) {
        for (const image of entry.images) {
          image.mesh.renderOrder = order;
          order += 0.00001;
        }
        if (entry.rain) {
          entry.rain.mesh.renderOrder = order;
          order += 0.00001;
        }
      }
    }
  }
  clearFrame(key?: string): void {
    this.clearLayers(this.frames, key);
  }
  private clearLayers(collection: Map<string, FrameView>, key?: string): void {
    const entries = key ? (collection.has(key) ? ([[key, collection.get(key)!]] as const) : []) : [...collection];
    for (const [id, entry] of entries) {
      entry.disposed = true;
      entry.rain?.destroy();
      entry.group.removeFromParent();
      for (const image of entry.images) this.removeImage(image);
      for (const release of entry.releases) release();
      collection.delete(id);
      this.pending.delete(entry);
    }
  }
  private removeImage(view: ImageView): void {
    view.generation++;
    view.lease?.release();
    view.mesh.removeFromParent();
    view.mesh.material.dispose();
    this.views.delete(view);
  }
  setFrameParticlesPaused(paused: boolean): void {
    this.paused = paused;
    for (const entry of this.frames.values()) entry.rain?.setPaused(paused);
  }
  snapshotFrameParticles(): Readonly<Record<string, AdvRainFrameSnapshot>> {
    return Object.fromEntries(
      [...this.frames].flatMap(([key, frame]) => (frame.rain ? [[key, frame.rain.snapshot()]] : [])),
    );
  }
  restoreFrameParticles(snapshots: Readonly<Record<string, AdvRainFrameSnapshot>>): void {
    for (const [key, snapshot] of Object.entries(snapshots)) this.frames.get(key)?.rain?.restore(snapshot);
  }
  setViewport(width: number, height: number): void {
    this.viewport.set(Math.max(1, width), Math.max(1, height));
    for (const view of this.views) {
      view.rect.set(0, 0, width, height);
      if (view.lease) this.crop(view, view.lease.value);
    }
    this.applyVideoLayout();
    for (const frame of this.frames.values()) this.layoutFrame(frame);
    for (const still of this.stills.values()) this.layoutFrame(still);
  }
  setOffset(x: number, y: number): void {
    this.offsetX = finite(x);
    this.offsetY = finite(y);
    for (const view of this.views) view.offset.set(this.offsetX, this.offsetY);
    this.setStillOffset(this.stillOffsetX, this.stillOffsetY);
    for (const frame of this.frames.values()) frame.rain?.setOffset(this.offsetX, this.offsetY);
  }
  setStillOffset(x: number, y: number): void {
    this.stillOffsetX = finite(x);
    this.stillOffsetY = finite(y);
    for (const view of [this.still, this.stillBackground, this.stillShade])
      view.offset.set(this.offsetX + this.stillOffsetX, this.offsetY + this.stillOffsetY);
    for (const still of this.stills.values())
      for (const image of still.images)
        image.offset.set(this.offsetX + this.stillOffsetX, this.offsetY + this.stillOffsetY);
  }
  async showStill(
    key: string,
    still: AdvStillEntry,
    opacity: number,
    presentation: StoryStillPresentation | undefined,
    animationIndex: number,
  ): Promise<void> {
    let entry = this.stills.get(key);
    if (!entry) {
      const frame: AdvFrameEntry = {
        texture: String(still.url || ""),
        ...(presentation ? { layout: presentation.layout, textures: { still: String(still.url || "") } } : {}),
      };
      const ready = this.createLayer(this.stills, key, frame, opacity);
      entry = this.stills.get(key)!;
      entry.ready = ready;
      entry.still = still;
      if (presentation) entry.animator = new StoryStillAnimator(presentation);
    }
    const operation = ++entry.operation;
    entry.group.visible = true;
    await entry.ready;
    if (entry.disposed || entry.operation !== operation) return;
    entry.group.visible = true;
    entry.opacity = alpha(opacity);
    entry.animator?.play(animationIndex);
    if (entry.animator) entry.layout = entry.animator.layout;
    for (const image of entry.images) this.opacity(image, entry.opacity);
    this.layoutFrame(entry);
    this.setStillOffset(this.stillOffsetX, this.stillOffsetY);
  }
  isStillVisible(key: string): boolean {
    return this.stills.get(key)?.group.visible ?? false;
  }
  stillOpacity(key: string): number {
    return this.stills.get(key)?.opacity ?? 0;
  }
  get visibleStillKeys(): readonly string[] {
    return [...this.stills].filter(([, entry]) => entry.group.visible).map(([key]) => key);
  }
  get topStill(): AdvStillEntry | null {
    return this.lastVisibleStill?.still ?? null;
  }
  setStillOpacity(key: string, value: number): void {
    const entry = this.stills.get(key);
    if (!entry) return;
    entry.opacity = alpha(value);
    for (const image of entry.images) this.opacity(image, entry.opacity);
  }
  hideStill(key: string): void {
    const entry = this.stills.get(key);
    if (!entry) return;
    entry.operation++;
    entry.group.visible = false;
    entry.animator?.stop();
    this.setStillOpacity(key, 0);
  }
  clearStills(): void {
    this.clearLayers(this.stills);
  }
  cancelPendingStills(): void {
    for (const [key, entry] of this.stills) if (this.pending.has(entry)) this.clearLayers(this.stills, key);
  }
  setStillSpeed(value: number): void {
    this.stillSpeed = Math.max(0, finite(value, 1));
  }
  snapshotStills(): readonly CanvasStillSnapshot[] {
    return [...this.stills]
      .filter(([, entry]) => entry.still)
      .map(([key, entry]) => ({
        key,
        still: entry.still!,
        visible: entry.group.visible,
        opacity: entry.opacity,
        ...(entry.animator ? { animation: entry.animator.snapshot() } : {}),
      }));
  }
  restoreStillAnimation(key: string, animation: StoryStillAnimationSnapshot | undefined, visible: boolean): void {
    const entry = this.stills.get(key);
    if (!entry) return;
    if (animation && entry.animator) {
      entry.animator.restore(animation);
      entry.layout = entry.animator.layout;
      this.layoutFrame(entry);
    }
    entry.group.visible = visible;
  }
  update(deltaSeconds: number): void {
    for (const frame of this.frames.values()) frame.rain?.update(deltaSeconds);
    if (!this.paused && deltaSeconds > 0)
      for (const [key, frame] of this.frames) {
        if (frame.opacity <= 0) continue;
        frame.elapsed += deltaSeconds;
        if (frame.frameAnimator) {
          frame.layout = frame.frameAnimator.sample(frame.elapsed);
          this.layoutFrame(frame);
        }
        const lifetime = finite(frame.frame.oneShotSeconds);
        if (lifetime > 0 && frame.elapsed >= lifetime) this.setFrameOpacity(key, 0, frame.slide);
      }
    if (!this.paused)
      for (const entry of this.stills.values())
        if (entry.group.visible && entry.animator) {
          const revision = entry.animator.revision;
          entry.animator.update(deltaSeconds * this.stillSpeed);
          if (entry.animator.revision !== revision) {
            entry.layout = entry.animator.layout;
            this.layoutFrame(entry);
          }
        }
  }
  render(): void {
    if (this.disposed) return;
    let visible = false;
    for (const view of this.views)
      if (view.mesh.visible) {
        visible = true;
        break;
      }
    if (!visible)
      for (const frame of this.frames.values())
        if (frame.rain?.mesh.visible && frame.rain.mesh.geometry.instanceCount) {
          visible = true;
          break;
        }
    if (!visible) return;
    const target = this.renderer.getRenderTarget(),
      autoClear = this.renderer.autoClear;
    try {
      this.renderer.autoClear = false;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
      this.renderer.setRenderTarget(target);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFrame();
    this.clearStills();
    for (const view of this.views) this.removeImage(view);
    this.videoTexture?.dispose();
    this.geometry.dispose();
  }
}
