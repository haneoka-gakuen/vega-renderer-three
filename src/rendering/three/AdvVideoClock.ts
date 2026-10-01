interface VideoFrameClock {
  mediaTime: number;
  callback: number | undefined;
  generation: number;
  dispose: () => void;
}

const clocks = new WeakMap<HTMLVideoElement, VideoFrameClock>();

/** Start one presentation clock per active element, before its first play. */
export function startVideoClock(video: HTMLVideoElement): void {
  stopVideoClock(video);
  if (typeof video.requestVideoFrameCallback !== "function") return;
  const clock: VideoFrameClock = {
    mediaTime: video.currentTime,
    callback: undefined,
    generation: 0,
    dispose: () => {},
  };
  const cancelFrame = (): void => {
    clock.generation += 1;
    if (clock.callback !== undefined) video.cancelVideoFrameCallback(clock.callback);
    clock.callback = undefined;
  };
  const requestFrame = (): void => {
    if (clocks.get(video) !== clock || clock.callback !== undefined) return;
    const generation = clock.generation;
    clock.callback = video.requestVideoFrameCallback((_now, metadata) => {
      if (clocks.get(video) !== clock || generation !== clock.generation) return;
      clock.callback = undefined;
      if (!video.seeking && Number.isFinite(metadata.mediaTime)) {
        clock.mediaTime = Math.max(0, metadata.mediaTime);
      }
      requestFrame();
    });
  };
  // currentTime can jump ahead before the corresponding frame is displayed.
  // Hold the presented value during a seek; a fresh callback admits its frame.
  const onSeeking = (): void => {
    cancelFrame();
  };
  const onSeeked = (): void => {
    requestFrame();
  };
  clock.dispose = (): void => {
    cancelFrame();
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("seeked", onSeeked);
  };
  clocks.set(video, clock);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("seeked", onSeeked);
  if (!video.seeking) requestFrame();
}

/** Media seconds of the displayed frame; older engines use the media clock. */
export function videoPresentedTime(video: HTMLVideoElement): number {
  // The last frame's PTS precedes duration by one frame. On normal completion,
  // permit an authored cue exactly at duration to reach its terminal boundary.
  if (video.ended) return video.currentTime;
  return clocks.get(video)?.mediaTime ?? video.currentTime;
}

export function stopVideoClock(video: HTMLVideoElement): void {
  const clock = clocks.get(video);
  clocks.delete(video);
  clock?.dispose();
}
