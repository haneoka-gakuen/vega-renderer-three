import type { AdvFrameEntry, AdvVideoEntry, StoryFrameLayoutProvider } from "@haneoka/vega/renderer-kit";
import type { WebGLRenderer } from "three";
import type { AdvRainFrameSnapshot } from "./AdvRainFrameRenderer";
import { AdvCanvasPass, type CanvasTextureLoader } from "./AdvCanvasPass";
import { videoAbortError, waitForVideo } from "./AdvVideoWait";

function absoluteLayer(zIndex: number): HTMLDivElement {
  const element = document.createElement("div");
  Object.assign(element.style, {
    position: "absolute",
    inset: "0",
    zIndex: String(zIndex),
    pointerEvents: "none",
    overflow: "hidden",
  });
  return element;
}

/** Media lifecycle and screen-space canvas composition. */
export class StoryDomOverlay {
  readonly root = absoluteLayer(20);
  readonly ruleTransitionLayer = absoluteLayer(60);
  private readonly videoLayer = absoluteLayer(28);
  readonly canvasPass: AdvCanvasPass;
  private animationIndex = 0;
  private video: HTMLVideoElement | null = null;
  private videoLoadController: AbortController | null = null;
  private readonly videoWaiters = new Set<() => void>();
  private readonly preloadedVideos = new Map<string, HTMLVideoElement>();
  private readonly videoPreloadPromises = new Map<string, Promise<void>>();
  private readonly episodeVideoSources = new Set<string>();
  private destroyed = false;
  private readonly mount: HTMLElement;
  private viewportX = 0;
  private viewportY = 0;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(
    mount: HTMLElement,
    renderer: WebGLRenderer,
    loadTexture: CanvasTextureLoader,
    layouts?: StoryFrameLayoutProvider,
  ) {
    this.mount = mount;
    this.canvasPass = new AdvCanvasPass(renderer, loadTexture, layouts);
    this.root.className = "adv-three-overlay";
    this.videoLayer.style.display = "none";
    this.root.append(this.videoLayer, this.ruleTransitionLayer);
    if (getComputedStyle(mount).position === "static") mount.style.position = "relative";
    mount.appendChild(this.root);
  }
  setStill(source: string, alpha: number): Promise<void> {
    return this.canvasPass.setStill(source, alpha);
  }
  setStillAlpha(alpha: number): void {
    this.canvasPass.setStillAlpha(alpha);
  }
  get stillAlpha(): number {
    return this.canvasPass.stillAlpha;
  }
  setStillViewAlpha(background: number, shade: number): void {
    this.canvasPass.setStillViewAlpha(background, shade);
  }
  get stillBackgroundAlpha(): number {
    return this.canvasPass.stillBackgroundAlpha;
  }
  get stillOverlayAlpha(): number {
    return this.canvasPass.stillOverlayAlpha;
  }
  setStillAnimationIndex(index: number): void {
    this.animationIndex = Math.max(0, Math.trunc(Number(index) || 0));
  }
  get stillAnimationIndex(): number {
    return this.animationIndex;
  }
  setCover(color: string, opacity: number): void {
    this.canvasPass.setCover(color || "#000000", clamp(opacity));
  }
  setFlash(opacity: number): void {
    this.canvasPass.setFlash(clamp(opacity));
  }
  setFrame(key: string, frame: AdvFrameEntry, alpha: number): Promise<void> {
    return this.canvasPass.setFrame(key, frame, alpha);
  }
  setFrameParticlesPaused(paused: boolean): void {
    this.canvasPass.setFrameParticlesPaused(paused);
  }
  snapshotFrameParticles(): Readonly<Record<string, AdvRainFrameSnapshot>> {
    return this.canvasPass.snapshotFrameParticles();
  }
  restoreFrameParticles(snapshots: Readonly<Record<string, AdvRainFrameSnapshot>>): void {
    this.canvasPass.restoreFrameParticles(snapshots);
  }
  setFrameOpacity(key: string, alpha: number, slide = 0): void {
    this.canvasPass.setFrameOpacity(key, alpha, slide);
  }
  clearFrame(key?: string): void {
    this.canvasPass.clearFrame(key);
  }
  update(deltaSeconds: number): void {
    this.canvasPass.update(deltaSeconds);
  }
  render(): void {
    this.canvasPass.render();
  }

  async preloadVideo(source: string, playableUrl: string, signal?: AbortSignal): Promise<void> {
    if (this.destroyed) throw videoAbortError("Story overlay was destroyed");
    if (!source) return;
    this.episodeVideoSources.add(source);
    const resident = this.preloadedVideos.get(source);
    if (resident && resident.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      return;
    }
    const pending = this.videoPreloadPromises.get(source);
    if (pending) return pending;
    if (resident) this.releaseVideoElement(resident);
    const video = document.createElement("video");
    video.src = playableUrl;
    video.playsInline = true;
    video.preload = "auto";
    video.autoplay = false;
    video.controls = false;
    video.muted = true;
    video.volume = 0;
    video.dataset.vegaSource = source;
    this.preloadedVideos.set(source, video);
    const preload = (async () => {
      video.load();
      await waitForVideo(video, "loadeddata", signal, HTMLMediaElement.HAVE_CURRENT_DATA);
      await waitForVideo(video, "canplay", signal, HTMLMediaElement.HAVE_FUTURE_DATA);
    })()
      .catch((error) => {
        if (this.preloadedVideos.get(source) === video) {
          this.preloadedVideos.delete(source);
        }
        this.releaseVideoElement(video);
        throw error;
      })
      .finally(() => {
        if (this.videoPreloadPromises.get(source) === preload) {
          this.videoPreloadPromises.delete(source);
        }
      });
    this.videoPreloadPromises.set(source, preload);
    await preload;
  }

  async showVideo(
    info: AdvVideoEntry | string,
    playbackRate: number,
    signal?: AbortSignal,
    playableUrl?: string,
  ): Promise<HTMLVideoElement> {
    if (this.destroyed) throw videoAbortError("Story overlay was destroyed");
    this.clearVideo();
    const loadController = new AbortController();
    const abortLoad = () => loadController.abort();
    if (signal?.aborted) loadController.abort();
    else signal?.addEventListener("abort", abortLoad, { once: true });
    this.videoLoadController = loadController;
    const source = typeof info === "string" ? info : String(info.playableUrl || info.src || info.url || "");
    const prepared = this.preloadedVideos.get(source);
    const video = prepared || document.createElement("video");
    this.preloadedVideos.delete(source);
    if (!prepared) video.src = playableUrl || source;
    video.dataset.vegaSource = source;
    video.playsInline = true;
    video.preload = "auto";
    video.autoplay = false;
    video.controls = false;
    video.muted = false;
    video.volume = 1;
    video.playbackRate = Math.max(0.1, Number(playbackRate) || 1);
    Object.assign(video.style, {
      width: "100%",
      height: "100%",
      display: "block",
      objectFit: "cover",
    });
    this.video = video;
    this.videoLayer.style.display = "block";
    this.videoLayer.style.opacity = "0";
    this.videoLayer.appendChild(video);
    try {
      await waitForVideo(video, "loadeddata", loadController.signal);
      if (this.destroyed || this.video !== video || loadController.signal.aborted) {
        throw videoAbortError("Video load was cancelled");
      }
      this.canvasPass.setVideo(video);
      await video.play();
      if (this.destroyed || this.video !== video || loadController.signal.aborted) {
        throw videoAbortError("Video playback was cancelled");
      }
      return video;
    } catch (error) {
      // Decode failure, autoplay rejection and lifecycle cancellation must all
      // unload the element instead of leaving a hidden media decoder.
      if (this.video === video) this.clearVideo();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortLoad);
      if (this.videoLoadController === loadController) this.videoLoadController = null;
    }
  }

  setVideoAlpha(alpha: number): void {
    this.canvasPass.setVideoAlpha(clamp(alpha));
  }

  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  waitVideoEnded(signal?: AbortSignal): Promise<void> {
    const video = this.video;
    if (!video || video.ended || this.destroyed || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        video.removeEventListener("ended", done);
        video.removeEventListener("error", done);
        signal?.removeEventListener("abort", done);
        this.videoWaiters.delete(done);
        resolve();
      };
      this.videoWaiters.add(done);
      video.addEventListener("ended", done, { once: true });
      // A decode/network failure stops media playback without dispatching
      // `ended`. Treat it as a terminal media state so an AdvVideo command
      // cannot leave the story scheduler waiting forever.
      video.addEventListener("error", done, { once: true });
      signal?.addEventListener("abort", done, { once: true });
      if (this.destroyed || this.video !== video || signal?.aborted) done();
    });
  }

  clearVideo(): void {
    this.canvasPass.setVideo(null);
    this.videoLoadController?.abort();
    this.videoLoadController = null;
    for (const settle of [...this.videoWaiters]) settle();
    if (this.video) {
      this.video.pause();
      const source = this.video.dataset.vegaSource || "";
      this.video.remove();
      if (!this.destroyed && source && this.episodeVideoSources.has(source)) {
        try {
          this.video.currentTime = 0;
        } catch {}
        this.video.muted = true;
        this.video.volume = 0;
        this.preloadedVideos.set(source, this.video);
      } else {
        this.releaseVideoElement(this.video);
      }
    }
    this.video = null;
    this.videoLayer.replaceChildren();
    this.videoLayer.style.opacity = "0";
    this.videoLayer.style.display = "none";
  }

  setOffset(x: number, y: number): void {
    this.offsetX = Number.isFinite(x) ? x : 0;
    this.offsetY = Number.isFinite(y) ? y : 0;
    this.layoutRoot();
    this.canvasPass.setOffset(this.offsetX, this.offsetY);
  }

  setStillOffset(x: number, y: number): void {
    const offsetX = Number.isFinite(x) ? x : 0;
    const offsetY = Number.isFinite(y) ? y : 0;
    this.canvasPass.setStillOffset(offsetX, offsetY);
  }

  setViewport(x: number, y: number, width: number, height: number): void {
    this.viewportX = Number.isFinite(x) ? x : 0;
    this.viewportY = Number.isFinite(y) ? y : 0;
    this.viewportWidth = Math.max(0, width);
    this.viewportHeight = Math.max(0, height);
    Object.assign(this.root.style, {
      inset: "auto",
      width: `${width}px`,
      height: `${height}px`,
    });
    this.layoutRoot();
    this.canvasPass.setViewport(width, height);
  }

  private layoutRoot(): void {
    // A transform would isolate descendants' blend modes. Apply UI shake via
    // layout coordinates so rain remains in the Three canvas' blend group.
    this.root.style.removeProperty("transform");
    this.root.style.left = `${this.viewportX + this.offsetX}px`;
    this.root.style.top = `${this.viewportY + this.offsetY}px`;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearVideo();
    for (const video of this.preloadedVideos.values()) {
      this.releaseVideoElement(video);
    }
    this.preloadedVideos.clear();
    this.videoPreloadPromises.clear();
    this.episodeVideoSources.clear();
    this.clearFrame();
    this.canvasPass.dispose();
    this.root.remove();
  }

  private releaseVideoElement(video: HTMLVideoElement): void {
    video.pause();
    video.remove();
    video.removeAttribute("src");
    video.load();
  }
}

function clamp(value: unknown): number {
  const numeric = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 0));
}
