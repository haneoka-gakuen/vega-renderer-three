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
  if (video.readyState >= minimumReadyState) return Promise.resolve();
  const timeout =
    Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0
      ? timeoutMilliseconds
      : DEFAULT_VIDEO_WAIT_TIMEOUT_MILLISECONDS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onReady = (): void => finish();
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
    video.addEventListener(event, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (video.readyState >= minimumReadyState) finish();
  });
}
