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

const VIDEO_PRELOAD_RESIDENCY_LIMIT = 2;
const VIDEO_PRELOAD_CONCURRENCY_LIMIT = 2;
const VIDEO_PRELOAD_TIMEOUT_MILLISECONDS = 1_500;
const VIDEO_SHOW_TIMEOUT_MILLISECONDS = 10_000;

interface VideoPreloadJob {
  readonly source: string;
  readonly playableUrl: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly detachCallerSignal: () => void;
}

export interface StoryDomOverlayOptions {
  /**
   * Notifies the scene owner when a source leaves DOM-video residency. The
   * Three scene owns the corresponding resolver lease and may release it only
   * after checking its own active/pending source ownership.
   */
  readonly onVideoResidencyReleased?: (source: string) => void;
}

async function playVideoWithTimeout(
  video: HTMLVideoElement,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<void> {
  if (signal.aborted) throw videoAbortError("Video playback was cancelled");
  const result = video.play();
  if (!result || typeof result.then !== "function") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(videoAbortError("Video playback was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for video playback after ${timeoutMilliseconds}ms`);
      error.name = "TimeoutError";
      finish(error);
    }, timeoutMilliseconds);
    Promise.resolve(result).then(
      () => finish(),
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
    if (signal.aborted) onAbort();
  });
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
  private readonly videoPreloadControllers = new Map<string, AbortController>();
  private readonly videoPreloadQueue: VideoPreloadJob[] = [];
  private activeVideoPreloads = 0;
  private readonly episodeVideoSources = new Set<string>();
  private readonly releasedVideos = new WeakSet<HTMLVideoElement>();
  private destroyed = false;
  private readonly mount: HTMLElement;
  private readonly onVideoResidencyReleased: ((source: string) => void) | undefined;
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
    options: StoryDomOverlayOptions = {},
  ) {
    this.mount = mount;
    this.onVideoResidencyReleased = options.onVideoResidencyReleased;
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
    if (signal?.aborted) throw videoAbortError("Video preload was cancelled");
    this.episodeVideoSources.add(source);
    const resident = this.preloadedVideos.get(source);
    if (resident && !this.videoPreloadPromises.has(source)) {
      this.touchPreloadedVideo(source, resident);
      return;
    }
    const pending = this.videoPreloadPromises.get(source);
    if (pending) return pending;
    if (resident) this.releasePreloadedVideo(source, resident);

    // Prewarming is intentionally best-effort. Keep the loader from waiting
    // behind a distant video or turning a valid story into a preload failure;
    // actual showVideo() performs its own bounded full-data wait.
    let resolve!: () => void;
    const preload = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
    const detachCallerSignal = (): void => signal?.removeEventListener("abort", abortFromCaller);
    const job: VideoPreloadJob = {
      source,
      playableUrl,
      controller,
      promise: preload,
      resolve,
      detachCallerSignal,
    };
    this.videoPreloadPromises.set(source, preload);
    this.videoPreloadControllers.set(source, controller);
    this.videoPreloadQueue.push(job);
    // The promise is retained for same-source coalescing. It resolves after
    // this bounded, metadata-only best-effort job finishes, including queued
    // work, so the loader's readiness contract has a real completion point.
    void preload.catch(() => undefined);
    this.drainVideoPreloadQueue();
    await preload;
  }

  async showVideo(
    info: AdvVideoEntry | string,
    playbackRate: number,
    signal?: AbortSignal,
    playableUrl?: string,
  ): Promise<HTMLVideoElement> {
    if (this.destroyed) throw videoAbortError("Story overlay was destroyed");
    // Replacing a current video is a show transition, not a hide. Do not put
    // an element whose load/play was just aborted back into the LRU.
    this.clearVideo(false);
    const loadController = new AbortController();
    const abortLoad = () => loadController.abort();
    if (signal?.aborted) loadController.abort();
    else signal?.addEventListener("abort", abortLoad, { once: true });
    this.videoLoadController = loadController;
    const source = typeof info === "string" ? info : String(info.playableUrl || info.src || info.url || "");
    const prepared = this.preloadedVideos.get(source);
    const usePrepared = Boolean(
      prepared && !this.videoPreloadPromises.has(source) && prepared.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
    );
    if (!usePrepared) {
      if (prepared) this.releasePreloadedVideo(source, prepared);
      this.cancelVideoPreload(source, "show video");
    } else {
      this.preloadedVideos.delete(source);
    }
    const video = usePrepared && prepared ? prepared : document.createElement("video");
    if (!usePrepared) video.src = playableUrl || source;
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
      await waitForVideo(
        video,
        "loadeddata",
        loadController.signal,
        HTMLMediaElement.HAVE_CURRENT_DATA,
        VIDEO_SHOW_TIMEOUT_MILLISECONDS,
      );
      if (this.destroyed || this.video !== video || loadController.signal.aborted) {
        throw videoAbortError("Video load was cancelled");
      }
      this.canvasPass.setVideo(video);
      await playVideoWithTimeout(video, loadController.signal, VIDEO_SHOW_TIMEOUT_MILLISECONDS);
      if (this.destroyed || this.video !== video || loadController.signal.aborted) {
        throw videoAbortError("Video playback was cancelled");
      }
      return video;
    } catch (error) {
      // Decode failure, autoplay rejection and lifecycle cancellation must all
      // unload the element instead of leaving a hidden media decoder.
      if (this.video === video) this.clearVideo(false);
      else this.releaseVideoElement(video);
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

  ownsVideoSource(source: string): boolean {
    return (
      !this.destroyed &&
      Boolean(
        source &&
        (this.video?.dataset.vegaSource === source ||
          this.preloadedVideos.has(source) ||
          this.videoPreloadPromises.has(source)),
      )
    );
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

  clearVideo(recache = true): void {
    this.canvasPass.setVideo(null);
    this.videoLoadController?.abort();
    this.videoLoadController = null;
    for (const settle of [...this.videoWaiters]) settle();
    if (this.video) {
      const video = this.video;
      this.video = null;
      video.pause();
      const source = video.dataset.vegaSource || "";
      video.remove();
      if (recache && !this.destroyed && source && this.episodeVideoSources.has(source)) {
        try {
          video.currentTime = 0;
        } catch {}
        video.muted = true;
        video.volume = 0;
        video.preload = "metadata";
        this.preloadedVideos.set(source, video);
        this.touchPreloadedVideo(source, video);
      } else {
        this.releaseVideoElement(video);
        if (!this.destroyed && source) this.notifyVideoResidencyReleased(source);
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
    this.cancelAllVideoPreloads();
    this.clearVideo(false);
    for (const video of this.preloadedVideos.values()) {
      this.releaseVideoElement(video);
    }
    this.preloadedVideos.clear();
    this.videoPreloadPromises.clear();
    this.videoPreloadControllers.clear();
    this.episodeVideoSources.clear();
    this.clearFrame();
    this.canvasPass.dispose();
    this.root.remove();
  }

  private releaseVideoElement(video: HTMLVideoElement): void {
    if (this.releasedVideos.has(video)) return;
    this.releasedVideos.add(video);
    video.pause();
    video.remove();
    video.removeAttribute("src");
    video.load();
  }

  private drainVideoPreloadQueue(): void {
    while (!this.destroyed && this.activeVideoPreloads < VIDEO_PRELOAD_CONCURRENCY_LIMIT) {
      const job = this.videoPreloadQueue.shift();
      if (!job) return;
      if (job.controller.signal.aborted || this.videoPreloadPromises.get(job.source) !== job.promise) {
        if (this.videoPreloadPromises.get(job.source) === job.promise) this.videoPreloadPromises.delete(job.source);
        if (this.videoPreloadControllers.get(job.source) === job.controller)
          this.videoPreloadControllers.delete(job.source);
        job.detachCallerSignal();
        job.resolve();
        if (!this.ownsVideoSource(job.source)) this.notifyVideoResidencyReleased(job.source);
        continue;
      }
      this.activeVideoPreloads += 1;
      void this.runVideoPreload(job).finally(() => {
        this.activeVideoPreloads -= 1;
        this.drainVideoPreloadQueue();
      });
    }
  }

  private async runVideoPreload(job: VideoPreloadJob): Promise<void> {
    let video: HTMLVideoElement | null = null;
    try {
      if (this.destroyed || job.controller.signal.aborted) throw videoAbortError("Video preload was cancelled");
      video = document.createElement("video");
      video.src = job.playableUrl;
      video.playsInline = true;
      // Metadata-only prewarm avoids starting a full decoder for every video
      // in the loader horizon. showVideo() upgrades a selected element to auto.
      video.preload = "metadata";
      video.autoplay = false;
      video.controls = false;
      video.muted = true;
      video.volume = 0;
      video.dataset.vegaSource = job.source;
      this.preloadedVideos.set(job.source, video);
      video.load();
      await waitForVideo(
        video,
        "loadedmetadata",
        job.controller.signal,
        HTMLMediaElement.HAVE_METADATA,
        VIDEO_PRELOAD_TIMEOUT_MILLISECONDS,
      );
      if (
        this.destroyed ||
        job.controller.signal.aborted ||
        this.videoPreloadPromises.get(job.source) !== job.promise ||
        this.preloadedVideos.get(job.source) !== video
      ) {
        throw videoAbortError("Video preload was cancelled");
      }
      this.touchPreloadedVideo(job.source, video);
    } catch {
      // Prewarming never owns playability. Any timeout/decode/abort drops the
      // candidate; the later show path will perform a fresh bounded load.
      if (video && this.preloadedVideos.get(job.source) === video) {
        this.preloadedVideos.delete(job.source);
        this.releaseVideoElement(video);
        if (!this.destroyed) this.notifyVideoResidencyReleased(job.source);
      } else if (video) {
        this.releaseVideoElement(video);
      }
    } finally {
      if (this.videoPreloadPromises.get(job.source) === job.promise) {
        this.videoPreloadPromises.delete(job.source);
      }
      if (this.videoPreloadControllers.get(job.source) === job.controller) {
        this.videoPreloadControllers.delete(job.source);
      }
      job.detachCallerSignal();
      job.resolve();
      if (!this.destroyed && !this.ownsVideoSource(job.source)) this.notifyVideoResidencyReleased(job.source);
    }
  }

  private touchPreloadedVideo(source: string, video: HTMLVideoElement): void {
    if (this.destroyed || this.preloadedVideos.get(source) !== video) return;
    this.preloadedVideos.delete(source);
    this.preloadedVideos.set(source, video);
    this.evictPreloadedVideos();
  }

  private evictPreloadedVideos(): void {
    while (this.preloadedVideos.size > VIDEO_PRELOAD_RESIDENCY_LIMIT) {
      let candidate: [string, HTMLVideoElement] | undefined;
      for (const entry of this.preloadedVideos) {
        if (entry[1] === this.video) continue;
        candidate = entry;
        break;
      }
      if (!candidate) return;
      const [source, video] = candidate;
      this.preloadedVideos.delete(source);
      this.cancelVideoPreload(source, "video LRU eviction");
      this.releaseVideoElement(video);
      if (!this.destroyed) this.notifyVideoResidencyReleased(source);
    }
  }

  private releasePreloadedVideo(source: string, video: HTMLVideoElement): void {
    if (this.preloadedVideos.get(source) === video) this.preloadedVideos.delete(source);
    this.cancelVideoPreload(source, "video residency release");
    this.releaseVideoElement(video);
    if (!this.destroyed) this.notifyVideoResidencyReleased(source);
  }

  private cancelVideoPreload(source: string, _reason: string): void {
    const controller = this.videoPreloadControllers.get(source);
    controller?.abort();
    const index = this.videoPreloadQueue.findIndex((job) => job.source === source);
    if (index >= 0) {
      const [job] = this.videoPreloadQueue.splice(index, 1);
      if (job) {
        job.controller.abort();
        if (this.videoPreloadPromises.get(source) === job.promise) this.videoPreloadPromises.delete(source);
        if (this.videoPreloadControllers.get(source) === job.controller) this.videoPreloadControllers.delete(source);
        job.detachCallerSignal();
        job.resolve();
      }
    }
  }

  private cancelAllVideoPreloads(): void {
    for (const job of this.videoPreloadQueue.splice(0)) {
      job.controller.abort();
      job.detachCallerSignal();
      job.resolve();
    }
    for (const controller of this.videoPreloadControllers.values()) controller.abort();
  }

  private notifyVideoResidencyReleased(source: string): void {
    if (!source) return;
    try {
      this.onVideoResidencyReleased?.(source);
    } catch (error) {
      console.warn("[StoryDomOverlay] video residency callback failed", error);
    }
  }
}

function clamp(value: unknown): number {
  const numeric = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 0));
}
