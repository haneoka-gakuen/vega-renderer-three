import type { StoryResourceResolver } from "@haneoka/vega/renderer-kit";

const abortError = (source: string, signal?: AbortSignal): unknown => {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error(`Loading was aborted: ${source}`);
  error.name = "AbortError";
  return error;
};

const loadBrowserImage = (
  source: string,
  signal?: AbortSignal,
): Promise<HTMLImageElement> => {
  if (signal?.aborted) return Promise.reject(abortError(source, signal));
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      callback();
    };
    const abort = () =>
      finish(() => {
        image.src = "";
        reject(abortError(source, signal));
      });
    image.onload = () => finish(() => resolve(image));
    image.onerror = () =>
      finish(() => reject(new Error(`Image failed to load: ${source}`)));
    signal?.addEventListener("abort", abort, { once: true });
    image.src = source;
  });
};

export const loadRendererImage = async (
  source: string,
  resources?: StoryResourceResolver,
  signal?: AbortSignal,
): Promise<HTMLImageElement> => {
  const renderable =
    resources?.canLoad(source) === true
      ? await resources.resolveRenderable(source, signal)
      : null;
  try {
    return await loadBrowserImage(renderable?.url ?? source, signal);
  } finally {
    renderable?.release();
  }
};
