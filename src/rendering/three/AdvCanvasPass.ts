import { ScopedRenderTargetSampling } from "../post/ScopedRenderTargetSampling";
import type { StoryDrawingBufferExtent } from "./StoryPhysicalViewport";
import {
  AddEquation,
  Color,
  CustomBlending,
  DoubleSide,
  Group,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Matrix4,
  PerspectiveCamera,
  Mesh,
  NormalBlending,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  SrcAlphaFactor,
  UnsignedByteType,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  VideoTexture,
  WebGLRenderTarget,
  type ShaderMaterial,
  type WebGLRenderer,
} from "three";
import {
  computeAdvFrameBandLayout,
  resolveStoryFrameLayout,
  resolveStoryCanvasScale,
  StoryStillAnimator,
  type AdvStillEntry,
  type StoryStillPresentation,
  type StoryStillAnimationSnapshot,
  type AdvFrameEntry,
  type StoryFrameLayout,
  type StoryCanvasCamera,
  type StoryFrameLayoutProvider,
  type StoryFrameNode,
} from "@haneoka/vega/renderer-kit";
import { AdvRainFrameRenderer, type AdvRainFrameSnapshot } from "./AdvRainFrameRenderer";
import { AdvFrameParticles } from "./AdvFrameParticles";
import { NativeFrameAnimator } from "./NativeFrameAnimation";
import { AdvUrpPostProcessor, type AdvColorGradingPipelineMode } from "../post/AdvUrpPostProcessor";
import type { AdvPostTextureResolver } from "../post/AdvUrpUberPost";
import type { AdvVolumeLayer } from "../post/AdvVolumeStack";

const NO_CANVAS_VOLUMES: readonly AdvVolumeLayer[] = Object.freeze([]);

export interface AdvCanvasPassOptions {
  readonly resolvePostTexture?: AdvPostTextureResolver;
  readonly colorGradingMode?: AdvColorGradingPipelineMode;
  readonly filmGrainMultiplier?: number;
  readonly resolveGrainPixelScale?: (width: number) => number;
  readonly postCamera?: StoryCanvasCamera;
}

export interface CanvasTextureLease {
  readonly value: Texture;
  release(): void;
}
export type CanvasTextureLoader = (source: string, signal?: AbortSignal) => Promise<CanvasTextureLease>;
/** Opaque batch used to prepare canvas layers without disturbing the live set. */
export interface CanvasLayerTransaction {
  readonly id: number;
}
const vertex = `precision highp float;
attribute vec3 position; attribute vec2 uv;
uniform vec2 uViewport; uniform vec2 uNativePixelPerCss; uniform vec4 uRect; uniform vec4 uCrop; uniform vec2 uOffset;
uniform mat3 uTransform;
uniform int uNativeEnabled; uniform mat4 uNativeTransform; uniform mat4 uNativeProjection; uniform vec3 uNativeParams;
varying vec2 vUv; varying vec2 vQuadUv;
void main(){ vec2 p=(uTransform*vec3(uRect.xy+vec2(position.x+0.5,0.5-position.y)*uRect.zw,1.0)).xy+uOffset;
if(uNativeEnabled!=0){
 vec2 local=uRect.xy+vec2(position.x+0.5,0.5-position.y)*uRect.zw;
 vec3 nativePoint=(uNativeTransform*vec4(local,0.0,1.0)).xyz;
 vec3 world=vec3(nativePoint.xy*uNativeParams.x+vec2(uOffset.x,-uOffset.y)*uNativePixelPerCss*uNativeParams.y,-uNativeParams.z-nativePoint.z*uNativeParams.x);
 gl_Position=uNativeProjection*vec4(world,1.0);
}else{gl_Position=vec4(2.0*p.x/uViewport.x-1.0,1.0-2.0*p.y/uViewport.y,0.0,1.0);}
vQuadUv=uv; vUv=uCrop.xy+uv*uCrop.zw; }`;
const fragment = `precision highp float;
uniform sampler2D uTexture; uniform vec4 uColor; uniform int uTextured; uniform vec2 uTileRepeat;
uniform int uSliceEnabled; uniform int uFillCenter; uniform vec4 uSliceBorder; uniform vec4 uSliceUvBorder; uniform vec4 uCrop;
varying vec2 vUv; varying vec2 vQuadUv;
float sliceAxis(float value,float start,float end,float sourceStart,float sourceEnd){
 if(start>0.0&&value<start)return value/start*sourceStart;
 if(end>0.0&&value>1.0-end)return 1.0-sourceEnd+(value-(1.0-end))/end*sourceEnd;
 float center=1.0-start-end;
 if(center<=0.0)return sourceStart;
 return sourceStart+(value-start)/center*(1.0-sourceStart-sourceEnd);
}
void main(){gl_FragColor=uColor;if(uTextured!=0){vec2 sampleUv=vUv;
 if(uSliceEnabled!=0){
  if(uFillCenter==0&&vQuadUv.x>=uSliceBorder.x&&vQuadUv.x<=1.0-uSliceBorder.z&&vQuadUv.y>=uSliceBorder.y&&vQuadUv.y<=1.0-uSliceBorder.w)discard;
  sampleUv=uCrop.xy+vec2(sliceAxis(vQuadUv.x,uSliceBorder.x,uSliceBorder.z,uSliceUvBorder.x,uSliceUvBorder.z),sliceAxis(vQuadUv.y,uSliceBorder.y,uSliceBorder.w,uSliceUvBorder.y,uSliceUvBorder.w))*uCrop.zw;
 }else if(uTileRepeat.x>0.0&&uTileRepeat.y>0.0)sampleUv=fract(vUv*uTileRepeat);
 gl_FragColor*=texture2D(uTexture,sampleUv);}}`;
const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const alpha = (value: unknown): number => Math.max(0, Math.min(1, finite(value)));
const roundEven = (value: number): number => {
  const lower = Math.floor(value), fraction = value - lower;
  return fraction === 0.5 ? lower + (lower % 2) : Math.round(value);
};
const simpleSpriteRect = (node: StoryFrameNode, width: number, height: number, target: Vector4): boolean => {
  const image = node.image, sprite = image?.sprite;
  if (!image || !sprite) return false;
  if (image.type !== 0 || image.useSpriteMesh !== false || sprite.packed !== false || sprite.packingRotation !== 0 ||
      image.tileSize || image.sliceBorder)
    throw new TypeError(`Unsupported Simple Sprite geometry: ${node.id}`);
  const fullWidth = sprite.rect[2], fullHeight = sprite.rect[3];
  const sourceWidth = roundEven(fullWidth), sourceHeight = roundEven(fullHeight);
  const [left, bottom, right, top] = sprite.padding;
  if (![fullWidth, fullHeight, left, bottom, right, top].every(Number.isFinite) ||
      !(fullWidth > 0 && fullHeight > 0 && sourceWidth > 0 && sourceHeight > 0))
    throw new TypeError(`Invalid Simple Sprite dimensions: ${node.id}`);
  if (image.preserveAspect) {
    const ratio = fullWidth / fullHeight;
    if (width / height > ratio) width = height * ratio;
    else height = width / ratio;
  }
  // Convert original bottom-up Sprite padding once into the existing top-down drawing rect.
  target.set(
    -node.pivot[0] * width + width * left / sourceWidth,
    -(1 - node.pivot[1]) * height + height * top / sourceHeight,
    width * (sourceWidth - left - right) / sourceWidth,
    height * (sourceHeight - bottom - top) / sourceHeight,
  );
  return true;
};
interface ImageView {
  readonly mesh: Mesh<PlaneGeometry, RawShaderMaterial>;
  readonly rect: Vector4;
  readonly crop: Vector4;
  readonly offset: Vector2;
  readonly color: Vector4;
  readonly transform: Matrix3;
  readonly nativeTransform: Matrix4;
  readonly nativeProjection: Matrix4;
  readonly nativeParams: Vector3;
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
  particles?: AdvFrameParticles;
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

interface LayerTransactionEntry {
  readonly collection: Map<string, FrameView>;
  readonly key: string;
  readonly entry: FrameView;
  readonly previous: FrameView | undefined;
  readonly operation: number;
}

interface LayerTransactionState {
  readonly entries: LayerTransactionEntry[];
  closed: boolean;
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
  private readonly cameraScene = new Scene();
  private readonly screenScene = new Scene();
  private readonly post: AdvUrpPostProcessor;
  private readonly screenGeometry = new PlaneGeometry(2, 2);
  private readonly screenMaterial = new RawShaderMaterial({
    vertexShader:
      "precision highp float; attribute vec3 position; attribute vec2 uv; varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}",
    fragmentShader:
      "precision highp float; uniform sampler2D tInput; varying vec2 vUv; void main(){gl_FragColor=texture2D(tInput,vUv);}",
    uniforms: { tInput: { value: null } },
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
  private readonly screenQuad = new Mesh<PlaneGeometry, ShaderMaterial | RawShaderMaterial>(
    this.screenGeometry,
    this.screenMaterial,
  );
  private cameraTarget: WebGLRenderTarget | undefined;
  private postTarget: WebGLRenderTarget | undefined;
  private volumeLayers: readonly AdvVolumeLayer[] = NO_CANVAS_VOLUMES;
  private postVolumeDirty = true;
  private postStillSet = false;
  private readonly drawingSize = new Vector2();
  private readonly savedClearColor = new Color();
  private readonly nativeCamera = new PerspectiveCamera();
  private actualViewport = false;
  private readonly postCamera: PerspectiveCamera | undefined;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly viewport = new Vector2(1, 1);
  private readonly views = new Set<ImageView>();
  private readonly frames = new Map<string, FrameView>();
  private readonly stills = new Map<string, FrameView>();
  private readonly pending = new Set<FrameView>();
  private readonly layerTransactions = new Map<CanvasLayerTransaction, LayerTransactionState>();
  private readonly layerOperations = new WeakMap<Map<string, FrameView>, Map<string, number>>();
  private readonly pendingLayers = new WeakMap<Map<string, FrameView>, Map<string, Set<FrameView>>>();
  private nextLayerTransactionId = 0;
  private readonly video: ImageView;
  private readonly videoBackground: ImageView;
  private readonly stillBackground: ImageView;
  private readonly still: ImageView;
  private readonly stillShade: ImageView;
  private readonly flash: ImageView;
  private readonly cover: ImageView;
  private videoTexture: VideoTexture | undefined;
  private videoFrameTime = Number.NaN;
  private videoLayout: import("@haneoka/vega/renderer-kit").StoryVideoLayout | undefined;
  private paused = false;
  private disposed = false;
  private physicalViewport: StoryDrawingBufferExtent | undefined;
  private readonly nativePixelPerCss = new Vector2(1, 1);
  private offsetX = 0;
  private offsetY = 0;
  private stillOffsetX = 0;
  private stillOffsetY = 0;
  private stillSpeed = 1;
  private frameSpeed = 1;
  private readonly preparingFrames = new Map<string, { frame: AdvFrameEntry; ready: Promise<unknown> }>();
  get ready(): boolean {
    return this.pending.size === 0;
  }

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly loadTexture: CanvasTextureLoader,
    private readonly layouts?: StoryFrameLayoutProvider,
    options: AdvCanvasPassOptions = {},
  ) {
    if (options.postCamera) {
      resolveStoryCanvasScale(options.postCamera, 1, 1);
      this.postCamera = new PerspectiveCamera(options.postCamera.fieldOfView, 1, options.postCamera.nearClip, options.postCamera.farClip);
      this.postCamera.updateMatrixWorld();
    }
    this.post = new AdvUrpPostProcessor({ resolveTexture: options.resolvePostTexture,
      filmGrainMultiplier: options.filmGrainMultiplier, resolveGrainPixelScale: options.resolveGrainPixelScale });
    this.postSampling = new ScopedRenderTargetSampling(this.renderer);
    this.post.setColorGradingMode(options.colorGradingMode ?? "ldr");
    this.screenQuad.frustumCulled = false;
    this.screenScene.add(this.screenQuad);
    this.cameraScene.matrixAutoUpdate = false;
    this.cameraScene.matrixWorldAutoUpdate = false;
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
  private image(order: number, parent: Scene | Group = order <= 32 ? this.cameraScene : this.scene): ImageView {
    const rect = new Vector4(0, 0, this.viewport.x, this.viewport.y),
      crop = new Vector4(0, 0, 1, 1);
    const offset = new Vector2(this.offsetX, this.offsetY),
      color = new Vector4(1, 1, 1, 0);
    const transform = new Matrix3();
    const nativeTransform = new Matrix4(),
      nativeProjection = new Matrix4(),
      nativeParams = new Vector3();
    const material = new RawShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uViewport: { value: this.viewport },
        uNativePixelPerCss: { value: this.nativePixelPerCss },
        uRect: { value: rect },
        uCrop: { value: crop },
        uOffset: { value: offset },
        uColor: { value: color },
        uTexture: { value: null },
        uTextured: { value: 0 },
        uTileRepeat: { value: new Vector2(0, 0) },
        uSliceEnabled: { value: 0 },
        uFillCenter: { value: 1 },
        uSliceBorder: { value: new Vector4() },
        uSliceUvBorder: { value: new Vector4() },
        uTransform: { value: transform },
        uNativeEnabled: { value: 0 },
        uNativeTransform: { value: nativeTransform },
        uNativeProjection: { value: nativeProjection },
        uNativeParams: { value: nativeParams },
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
      nativeTransform,
      nativeProjection,
      nativeParams,
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
  private async source(view: ImageView, source: string, signal?: AbortSignal): Promise<boolean> {
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
      lease = await this.loadTexture(source, signal);
    } catch (error) {
      if (this.disposed || !this.views.has(view) || generation !== view.generation) return false;
      if (signal?.aborted) {
        view.source = view.leaseSource;
        return false;
      }
      view.source = view.leaseSource;
      throw error;
    }
    if (this.disposed || !this.views.has(view) || generation !== view.generation || signal?.aborted) {
      lease.release();
      if (signal?.aborted && this.views.has(view) && generation === view.generation) view.source = view.leaseSource;
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
      { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
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
  async setStill(source: string, opacity: number, signal?: AbortSignal): Promise<void> {
    if ((await this.source(this.still, source, signal)) && !signal?.aborted)
      this.opacity(this.still, source ? opacity : 0);
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
    this.videoFrameTime = Number.NaN;
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
  async setFrame(key: string, frame: AdvFrameEntry, value: number, signal?: AbortSignal): Promise<void> {
    const preparation = this.preparingFrames.get(key);
    if (preparation?.frame === frame) {
      await preparation.ready;
      return;
    }
    const current = this.frames.get(key);
    if (current && current.frame === frame && !current.disposed) {
      // UIAdvWidget.SetFrame brings the retained instance to the front. It
      // does not restart its Animator or particle simulation before the delay.
      current.group.removeFromParent();
      this.scene.add(current.group);
      this.frames.delete(key);
      this.frames.set(key, current);
      this.orderFrames();
      return;
    }
    const pending = { frame, ready: this.createLayer(this.frames, key, frame, value, signal) };
    this.preparingFrames.set(key, pending);
    try { await pending.ready; }
    finally { if (this.preparingFrames.get(key) === pending) this.preparingFrames.delete(key); }
  }
  playFrameAnimation(key: string, frame: AdvFrameEntry): void {
    const current = this.frames.get(key);
    if (!current || current.disposed) return;
    const layout = current.frame.layout as StoryFrameLayout | undefined;
    current.elapsed = 0;
    if (layout && frame.animation) current.frameAnimator = new NativeFrameAnimator(layout, frame.animation);
    else delete current.frameAnimator;
    if (layout) current.layout = current.frameAnimator?.sample(0) ?? layout;
    current.particles?.selectAnimation(frame.animation?.name, frame.animation?.speed, frame.animation?.loop);
    this.layoutFrame(current);
  }
  beginLayerTransaction(): CanvasLayerTransaction {
    const transaction = { id: ++this.nextLayerTransactionId };
    this.layerTransactions.set(transaction, { entries: [], closed: false });
    return transaction;
  }
  async stageFrame(
    transaction: CanvasLayerTransaction,
    key: string,
    frame: AdvFrameEntry,
    value: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return Boolean(await this.createLayer(this.frames, key, frame, value, signal, transaction));
  }
  async stageStill(
    transaction: CanvasLayerTransaction,
    key: string,
    still: AdvStillEntry,
    opacity: number,
    presentation: StoryStillPresentation | undefined,
    animationIndex: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const frame: AdvFrameEntry = {
      texture: String(still.url || ""),
      ...(presentation ? { layout: presentation.layout, textures: { still: String(still.url || "") } } : {}),
    };
    const entry = await this.createLayer(this.stills, key, frame, opacity, signal, transaction);
    if (!entry) return false;
    entry.still = still;
    if (presentation) entry.animator = new StoryStillAnimator(presentation);
    entry.operation = animationIndex;
    return true;
  }
  commitLayerTransaction(transaction: CanvasLayerTransaction): void {
    const state = this.layerTransactions.get(transaction);
    if (!state || state.closed) return;
    const valid = state.entries.every((item) => {
      const operations = this.layerOperations.get(item.collection);
      return (
        !item.entry.disposed &&
        item.collection.get(item.key) === item.previous &&
        operations?.get(item.key) === item.operation
      );
    });
    if (!valid) {
      state.closed = true;
      for (const item of state.entries) this.disposeEntry(item.entry);
      this.layerTransactions.delete(transaction);
      throw new Error("Canvas layer transaction was superseded or cleared");
    }
    state.closed = true;
    const replaced = new Set<FrameView>();
    for (const item of state.entries) {
      item.collection.set(item.key, item.entry);
      item.entry.group.visible = true;
      if (item.previous) replaced.add(item.previous);
    }
    for (const entry of replaced) this.disposeEntry(entry);
    this.orderFrames();
    this.layerTransactions.delete(transaction);
  }
  discardLayerTransaction(transaction: CanvasLayerTransaction): void {
    const state = this.layerTransactions.get(transaction);
    if (!state || state.closed) return;
    state.closed = true;
    for (const item of state.entries) this.disposeEntry(item.entry);
    this.layerTransactions.delete(transaction);
  }
  private async createLayer(
    collection: Map<string, FrameView>,
    key: string,
    frame: AdvFrameEntry,
    value: number,
    signal?: AbortSignal,
    transaction?: CanvasLayerTransaction,
  ): Promise<FrameView | null> {
    if (signal?.aborted || this.disposed) return null;
    const previous = collection.get(key);
    const operations = this.layerOperations.get(collection) ?? new Map<string, number>();
    this.layerOperations.set(collection, operations);
    const operation = (operations.get(key) ?? 0) + 1;
    operations.set(key, operation);
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
    this.pending.add(entry);
    const pendingByKey = this.pendingLayers.get(collection) ?? new Map<string, Set<FrameView>>();
    this.pendingLayers.set(collection, pendingByKey);
    const pending = pendingByKey.get(key) ?? new Set<FrameView>();
    pendingByKey.set(key, pending);
    pending.add(entry);
    (collection === this.stills ? this.cameraScene : this.scene).add(entry.group);
    entry.group.visible = false;
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
          if (!node.image || node.image.enabled === false) continue;
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
          if (source) loads.push(this.source(image, source, signal));
        }
        await Promise.all(loads);
        if (collection === this.frames) await this.createFrameParticles(key, entry, frame, layout);
      } else if (kind.includes("rain")) {
        const texture = String(frame.texture || "");
        if (!texture) throw new Error("Rain frame requires a particle texture");
        const lease = await this.loadTexture(texture, signal);
        if (entry.disposed) {
          lease.release();
          return null;
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
        if (source) await this.source(image, source, signal);
        else this.setColor(image, frame.color || "#000000");
        if (!entry.disposed) this.opacity(image, entry.opacity);
      }
      if (entry.disposed) return null;
      if (signal?.aborted || this.disposed) {
        this.disposeEntry(entry);
        return null;
      }
      if (!entry.disposed) {
        if (entry.frameAnimator) entry.layout = entry.frameAnimator.sample(0);
        this.layoutFrame(entry);
        this.orderFrames();
      }
      if (transaction) {
        const state = this.layerTransactions.get(transaction);
        if (!state || state.closed) {
          this.disposeEntry(entry);
          return null;
        }
        state.entries.push({ collection, key, entry, previous, operation });
      } else if (operations.get(key) === operation) {
        collection.set(key, entry);
        entry.group.visible = true;
        if (previous) this.disposeEntry(previous);
        this.orderFrames();
      } else {
        this.disposeEntry(entry);
        return null;
      }
      return entry;
    } catch (error) {
      if (entry.disposed) return null;
      this.disposeEntry(entry);
      if (signal?.aborted) return null;
      throw error;
    } finally {
      this.pending.delete(entry);
      const pendingByKey = this.pendingLayers.get(collection);
      const pending = pendingByKey?.get(key);
      pending?.delete(entry);
      if (pending?.size === 0) pendingByKey?.delete(key);
    }
  }
  setFrameOpacity(key: string, value: number, slide: number): void {
    const entry = this.frames.get(key);
    if (!entry) return;
    entry.opacity = alpha(value);
    entry.slide = finite(slide);
    for (const image of entry.images) this.opacity(image, entry.opacity);
    entry.rain?.setOpacity(entry.opacity);
    entry.particles?.setOpacity(entry.opacity);
    this.layoutFrame(entry);
  }
  private layoutFrame(entry: FrameView): void {
    const { x: width, y: height } = this.viewport,
      kind = String(entry.frame.type || "").toLowerCase();
    entry.rain?.setViewport(width, height);
    const nativeExtent = entry.layout?.camera ? this.physicalViewport : undefined;
    const layoutWidth = nativeExtent?.width ?? width, layoutHeight = nativeExtent?.height ?? height;
    entry.particles?.layout(entry.layout, layoutWidth, layoutHeight);
    if (entry.layout) {
      const placements = new Map(
        resolveStoryFrameLayout(entry.layout, layoutWidth, layoutHeight).map((placement) => [placement.node.id, placement]),
      );
      for (const image of entry.images) {
        const placement = placements.get(image.node!.id)!;
        let w = placement.width,
          h = placement.height;
        const tile = placement.node.image?.tileSize;
        const tileRepeat = image.mesh.material.uniforms.uTileRepeat!.value as Vector2;
        if (tile && tile[0] > 0 && tile[1] > 0) tileRepeat.set(w / tile[0], h / tile[1]);
        else tileRepeat.set(0, 0);
        const slice = placement.node.image?.sliceBorder;
        const sliceUv = placement.node.image?.sliceUvBorder;
        const uniforms = image.mesh.material.uniforms;
        uniforms.uSliceEnabled!.value = slice && sliceUv && w > 0 && h > 0 ? 1 : 0;
        uniforms.uFillCenter!.value = placement.node.image?.fillCenter === false ? 0 : 1;
        if (slice && sliceUv && w > 0 && h > 0) {
          const border = uniforms.uSliceBorder!.value as Vector4;
          const sourceBorder = uniforms.uSliceUvBorder!.value as Vector4;
          const horizontal = Math.max(w, slice[0] + slice[2]);
          const vertical = Math.max(h, slice[1] + slice[3]);
          border.set(slice[0] / horizontal, slice[1] / vertical, slice[2] / horizontal, slice[3] / vertical);
          sourceBorder.set(...sliceUv);
        }
        const source = image.lease?.value.image as { width?: number; height?: number } | undefined;
        const visibleSprite = entry.group.visible && placement.node.image?.enabled !== false &&
          entry.opacity * placement.opacity * (placement.node.image?.color[3] ?? 1) > 0;
        const hasSpriteRect = visibleSprite && simpleSpriteRect(placement.node, w, h, image.rect);
        if (!hasSpriteRect && !tile && image.node?.image?.preserveAspect && source?.width && source.height) {
          const ratio = source.width / source.height;
          if (w / h > ratio) w = h * ratio;
          else h = w / ratio;
        }
        const nativeCamera = entry.layout.camera;
        image.mesh.material.uniforms.uNativeEnabled!.value = nativeCamera && placement.transform3D ? 1 : 0;
        if (nativeCamera && placement.transform3D) {
          this.nativeCamera.fov = nativeCamera.fieldOfView;
          this.nativeCamera.aspect = layoutWidth / layoutHeight;
          this.nativeCamera.near = nativeCamera.nearClip;
          this.nativeCamera.far = nativeCamera.farClip;
          this.nativeCamera.updateProjectionMatrix();
          image.nativeProjection.copy(this.nativeCamera.projectionMatrix);
          image.nativeTransform.fromArray(placement.transform3D);
          const scaler = resolveStoryCanvasScale(nativeCamera, layoutWidth, layoutHeight);
          const worldPerPixel =
            (2 * nativeCamera.planeDistance * Math.tan((nativeCamera.fieldOfView * Math.PI) / 360)) / layoutHeight;
          image.nativeParams.set(worldPerPixel * scaler, worldPerPixel, nativeCamera.planeDistance);
        }
        const [a, b, c, d, x, y] = placement.transform;
        image.transform.set(a, c, x, b, d, y, 0, 0, 1);
        if (!hasSpriteRect) image.rect.set(-placement.node.pivot[0] * w, -(1 - placement.node.pivot[1]) * h, w, h);
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
        if (entry.particles) {
          entry.particles.setRenderOrder(order);
          order += 0.00001;
        }
      }
    }
  }
  clearFrame(key?: string): void {
    this.clearLayers(this.frames, key);
  }
  /**
   * Frames whose serialized prefab carries ParticleSystems replay them through
   * the shared Unity particle runtime, with each emitter placed by its
   * RectTransform through the same layout anchoring as the static images.
   * Simulation advances on the frame elapsed clock and the emitted alpha is
   * scaled by the frame opacity; failures degrade to the static layout only.
   */
  private async createFrameParticles(
    key: string,
    entry: FrameView,
    frame: AdvFrameEntry,
    layout: StoryFrameLayout,
  ): Promise<void> {
    if (!frame.particles?.length || !frame.particleRuntime) return;
    let particles: AdvFrameParticles;
    try {
      particles = await AdvFrameParticles.create(frame, layout, key);
    } catch (error) {
      if (!entry.disposed) console.warn(`Frame particle replay is unavailable: ${key}`, error);
      return;
    }
    if (entry.disposed) {
      particles.dispose();
      return;
    }
    entry.particles = particles;
    entry.group.add(particles.group);
    particles.layout(layout, this.viewport.x, this.viewport.y);
    particles.setOpacity(entry.opacity);
    particles.setRenderOrder(0);
    particles.play();
  }

  private clearLayers(collection: Map<string, FrameView>, key?: string): void {
    const pendingByKey = this.pendingLayers.get(collection);
    const keys = key ? new Set([key]) : this.layerKeys(collection);
    const operations = this.layerOperations.get(collection) ?? new Map<string, number>();
    this.layerOperations.set(collection, operations);
    for (const id of keys) {
      operations.set(id, (operations.get(id) ?? 0) + 1);
      const entries = new Set<FrameView>();
      const current = collection.get(id);
      if (current) entries.add(current);
      for (const entry of pendingByKey?.get(id) ?? []) entries.add(entry);
      for (const transaction of this.layerTransactions.values())
        for (const item of transaction.entries)
          if (item.collection === collection && item.key === id) entries.add(item.entry);
      for (const entry of entries) this.disposeEntry(entry);
      collection.delete(id);
      pendingByKey?.delete(id);
    }
  }
  private layerKeys(collection: Map<string, FrameView>): Set<string> {
    const keys = new Set([...collection.keys(), ...(this.pendingLayers.get(collection)?.keys() ?? [])]);
    for (const transaction of this.layerTransactions.values())
      for (const item of transaction.entries) if (item.collection === collection) keys.add(item.key);
    return keys;
  }
  private disposeEntry(entry: FrameView): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.rain?.destroy();
    entry.particles?.dispose();
    entry.particles = undefined;
    entry.group.removeFromParent();
    for (const image of entry.images) this.removeImage(image);
    for (const release of entry.releases) release();
    this.pending.delete(entry);
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
  setViewport(width: number, height: number, physical?: StoryDrawingBufferExtent): void {
    this.actualViewport = [width,height].every((value)=>Number.isFinite(value)&&value>0);
    this.viewport.set(Math.max(1, width), Math.max(1, height));
    if (physical && ![physical.width, physical.height].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new TypeError("Invalid measured canvas extent");
    this.physicalViewport = physical;
    this.nativePixelPerCss.set(physical ? physical.width / this.viewport.x : 1, physical ? physical.height / this.viewport.y : 1);
    const aspect = physical ? physical.width / physical.height : this.viewport.x / this.viewport.y;
    if (this.postCamera && this.postCamera.aspect !== aspect) {
      this.postCamera.aspect = aspect;
      this.postCamera.updateProjectionMatrix();
    }
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
    signal?: AbortSignal,
  ): Promise<void> {
    let entry = this.stills.get(key);
    if (!entry) {
      const frame: AdvFrameEntry = {
        texture: String(still.url || ""),
        ...(presentation ? { layout: presentation.layout, textures: { still: String(still.url || "") } } : {}),
      };
      entry = (await this.createLayer(this.stills, key, frame, opacity, signal)) ?? undefined;
      if (!entry) return;
      entry.still = still;
      if (presentation) entry.animator = new StoryStillAnimator(presentation);
    }
    const operation = ++entry.operation;
    entry.group.visible = true;
    if (signal?.aborted) return;
    if (entry.disposed || entry.operation !== operation) return;
    entry.group.visible = true;
    entry.opacity = alpha(opacity);
    this.requestStillAttachment(key);
    entry.animator?.play(animationIndex);
    if (entry.animator) entry.layout = entry.animator.layout;
    for (const image of entry.images) this.opacity(image, entry.opacity);
    this.layoutFrame(entry);
    this.setStillOffset(this.stillOffsetX, this.stillOffsetY);
  }
  /** Existing verified instance at the actual SetStill command boundary. */
  requestStillAttachment(key: string): void {
    const entry = this.stills.get(key);
    if (!entry || entry.disposed || !entry.animator?.presentation.layout.stillExternalLayout) return;
    entry.animator.requestAttachment();
    this.stills.delete(key);this.stills.set(key,entry);
    this.orderFrames();
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
  clearStills(keep?: string | ReadonlySet<string>): void {
    const keepKeys = typeof keep === "string" ? new Set([keep]) : keep;
    for (const key of this.layerKeys(this.stills)) if (!keepKeys?.has(key)) this.clearLayers(this.stills, key);
  }
  clearFramesExcept(keep: ReadonlySet<string>): void {
    for (const key of this.layerKeys(this.frames)) if (!keep.has(key)) this.clearLayers(this.frames, key);
  }
  cancelPendingStills(): void {
    const pendingByKey = this.pendingLayers.get(this.stills);
    const operations = this.layerOperations.get(this.stills) ?? new Map<string, number>();
    this.layerOperations.set(this.stills, operations);
    for (const [key, entries] of pendingByKey ?? []) {
      operations.set(key, (operations.get(key) ?? 0) + 1);
      for (const entry of entries) this.disposeEntry(entry);
      pendingByKey?.delete(key);
    }
  }
  setStillSpeed(value: number): void {
    this.stillSpeed = Math.max(0, finite(value, 1));
  }
  setFrameSpeed(value: number): void {
    this.frameSpeed = Math.max(0, finite(value, 1));
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
    const texture = this.videoTexture;
    const video = texture?.image as HTMLVideoElement | undefined;
    if (
      texture &&
      video &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      Number.isFinite(video.currentTime)
    ) {
      if (video.currentTime !== this.videoFrameTime) {
        this.videoFrameTime = video.currentTime;
        texture.needsUpdate = true;
      }
    }
    for (const frame of this.frames.values()) frame.rain?.update(deltaSeconds);
    if (!this.paused && deltaSeconds > 0)
      for (const [key, frame] of this.frames) {
        if (frame.opacity <= 0) continue;
        frame.elapsed += deltaSeconds * this.frameSpeed;
        // AdvFrame.SpeedRate changes Animator.speed; native ParticleSystems
        // keep their simulation clock and sample rate-driven module curves.
        frame.particles?.update(deltaSeconds, this.frameSpeed);
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
  setVolumeLayers(layers: readonly AdvVolumeLayer[]): void {
    this.volumeLayers = layers;
    this.postVolumeDirty = true;
  }

  resetTemporalHistory(): void {
    this.post.resetTemporalHistory();
  }

  private hasCameraContent(): boolean {
    if (
      this.video.mesh.visible ||
      this.videoBackground.mesh.visible ||
      this.still.mesh.visible ||
      this.stillBackground.mesh.visible ||
      this.stillShade.mesh.visible
    )
      return true;
    for (const entry of this.stills.values()) if (entry.group.visible && entry.opacity > 0) return true;
    return false;
  }

  private hasFrontContent(): boolean {
    for (const view of this.views) if (view.mesh.visible && view.mesh.parent === this.scene) return true;
    for (const entry of this.frames.values()) if (entry.group.visible && entry.opacity > 0) return true;
    return false;
  }

  private hasStillSet(): boolean {
    if (this.still.lease !== undefined) return true;
    for (const entry of this.stills.values()) if (entry.group.visible) return true;
    return false;
  }

  private ensureCameraTargets(): void {
    this.renderer.getDrawingBufferSize(this.drawingSize);
    const width = Math.max(1, Math.round(this.drawingSize.x));
    const height = Math.max(1, Math.round(this.drawingSize.y));
    if (!this.cameraTarget || !this.postTarget) {
      const create = (name: string): WebGLRenderTarget => {
        const target = new WebGLRenderTarget(width, height, {
          // Preserve the existing renderer's portable path on devices that
          // cannot render float colour attachments; capable devices use HDR.
          type: this.renderer.getContext().getExtension("EXT_color_buffer_float") ? HalfFloatType : UnsignedByteType,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          depthBuffer: false,
          stencilBuffer: false,
        });
        target.texture.name = name;
        target.texture.colorSpace = NoColorSpace;
        target.texture.generateMipmaps = false;
        return target;
      };
      this.cameraTarget = create("adv-video-still-camera");
      this.postTarget = create("adv-video-still-post");
    } else if (this.cameraTarget.width !== width || this.cameraTarget.height !== height) {
      const aspectChanged = Math.fround(this.cameraTarget.width / this.cameraTarget.height) !== Math.fround(width / height);
      this.cameraTarget.setSize(width, height);
      this.postTarget.setSize(width, height);
      if (!this.physicalViewport || aspectChanged) this.resetTemporalHistory();
    }
  }

  private readonly postSampling: ScopedRenderTargetSampling;
  private readonly renderFullscreen = (
    material: ShaderMaterial,
    target: WebGLRenderTarget | null,
    clear: boolean,
  ): void => {
    this.screenQuad.material = material;
    this.renderer.setRenderTarget(target);
    if (clear) this.renderer.clear(true, false, false);
    this.postSampling.render(material, () => this.renderer.render(this.screenScene, this.camera));
  };

  render(frameStamp?: number): void {
    if (this.disposed) return;
    // The real canvas-layout phase follows update. Hidden instances also consume pending XY.
    if (this.actualViewport) for (const entry of this.stills.values()) {
      if (!entry.disposed && entry.animator?.presentation.layout.stillExternalLayout) {
        entry.animator.consumeAttachment(this.physicalViewport?.width ?? this.viewport.x,this.physicalViewport?.height ?? this.viewport.y);
        entry.layout=entry.animator.layout;
        if(entry.group.visible) this.layoutFrame(entry);
      }
    }
    const cameraVisible = this.hasCameraContent();
    const frontVisible = this.hasFrontContent();
    if (!cameraVisible && !frontVisible) return;
    const target = this.renderer.getRenderTarget();
    const autoClear = this.renderer.autoClear;
    const clearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    try {
      this.renderer.autoClear = false;
      if (cameraVisible) {
        this.ensureCameraTargets();
        // VideoCanvas and StillCanvas share their own camera colour/post pair.
        // UIAdvWidget suppresses that camera's volume mask while a still is set.
        const stillSet = this.hasStillSet();
        if (this.postVolumeDirty || this.postStillSet !== stillSet) {
          this.post.setVolumeLayers(stillSet ? NO_CANVAS_VOLUMES : this.volumeLayers);
          this.postVolumeDirty = false;
          this.postStillSet = stillSet;
        }
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.setRenderTarget(this.cameraTarget!);
        this.renderer.clear(true, false, false);
        this.renderer.render(this.cameraScene, this.camera);
        const output = this.post.render(this.cameraTarget!, this.postTarget!, this.renderFullscreen, this.postCamera ?? this.camera, frameStamp);
        this.screenQuad.material = this.screenMaterial;
        this.screenMaterial.uniforms.tInput!.value = output.texture;
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.screenScene, this.camera);
      }
      // FrameCanvas/front flash are composited after the screen image. They
      // never inherit the video/still camera's post-processing volume stack.
      this.renderer.setRenderTarget(target);
      if (frontVisible) this.renderer.render(this.scene, this.camera);
    } finally {
      this.screenQuad.material = this.screenMaterial;
      this.renderer.setClearColor(this.savedClearColor, clearAlpha);
      this.renderer.autoClear = autoClear;
      this.renderer.setRenderTarget(target);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const transaction of this.layerTransactions.keys()) this.discardLayerTransaction(transaction);
    this.clearFrame();
    this.clearStills();
    for (const view of this.views) this.removeImage(view);
    this.videoTexture?.dispose();
    this.cameraTarget?.dispose();
    this.postTarget?.dispose();
    this.post.dispose();
    this.postSampling.dispose();
    this.screenMaterial.dispose();
    this.screenGeometry.dispose();
    this.geometry.dispose();
  }
}
