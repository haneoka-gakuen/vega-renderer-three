export function videoAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function videoTimeoutError(video: HTMLVideoElement, event: string, timeoutMilliseconds: number): Error {
  const error = new Error(`Timed out waiting for video ${event} after ${timeoutMilliseconds}ms`);
  error.name = "TimeoutError";
  Object.assign(error, { video, event });
  return error;
}

const DEFAULT_VIDEO_WAIT_TIMEOUT_MILLISECONDS = 10_000;

export function waitForVideo(
  video: HTMLVideoElement,
  event: string,
  signal?: AbortSignal,
  minimumReadyState: number = HTMLMediaElement.HAVE_CURRENT_DATA,
  timeoutMilliseconds = DEFAULT_VIDEO_WAIT_TIMEOUT_MILLISECONDS,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(videoAbortError("Video load was cancelled"));
  if (video.error) return Promise.reject(new Error(video.error.message || "Video failed to load"));
  if (video.readyState >= minimumReadyState) return Promise.resolve();
  const timeout =
    Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0
      ? timeoutMilliseconds
      : DEFAULT_VIDEO_WAIT_TIMEOUT_MILLISECONDS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onReady = (): void => {
      if (video.readyState >= minimumReadyState) finish();
    };
    const onError = (): void => finish(new Error(video.error?.message || "Video failed to load"));
    const onAbort = (): void => finish(videoAbortError("Video load was cancelled"));
    const onTimeout = (): void => finish(videoTimeoutError(video, event, timeout));
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      video.removeEventListener(event, onReady);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(onTimeout, timeout);
    video.addEventListener(event, onReady);
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (video.error) onError();
    else if (video.readyState >= minimumReadyState) finish();
  });
}

/** Seek only when necessary, including zero when reusing a resident element. */
export function seekVideoTime(
  video: HTMLVideoElement,
  seconds: number,
  signal?: AbortSignal,
  timeoutMilliseconds = DEFAULT_VIDEO_WAIT_TIMEOUT_MILLISECONDS,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(videoAbortError("Video seek was cancelled"));
  if (video.error) return Promise.reject(new Error(video.error.message || "Video seek failed"));
  if (!Number.isFinite(seconds)) return Promise.reject(new RangeError("Video seek time must be finite"));
  const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : Infinity;
  const target = Math.min(Math.max(0, seconds), duration);
  if (!video.seeking && video.currentTime === target) return Promise.resolve();
  const timeout =
    Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0
      ? timeoutMilliseconds
      : DEFAULT_VIDEO_WAIT_TIMEOUT_MILLISECONDS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = (): void => {
      if (!video.seeking) finish();
    };
    const onError = (): void => finish(new Error(video.error?.message || "Video seek failed"));
    const onAbort = (): void => finish(videoAbortError("Video seek was cancelled"));
    const timer = setTimeout(() => finish(videoTimeoutError(video, "seeked", timeout)), timeout);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) onAbort();
      else {
        if (video.currentTime !== target) video.currentTime = target;
        // Some engines complete a no-op seek without dispatching seeked.
        if (!video.seeking && video.currentTime === target) finish();
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
