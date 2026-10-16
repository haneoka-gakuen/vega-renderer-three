export interface SceneAnimationClockSnapshot {
  readonly version: 1;
  readonly timeSeconds: number;
  readonly frame: number;
}

interface Subscriber {
  readonly revision: number;
  readonly tick: (timeSeconds: number) => void;
  readonly invalidated: () => void;
}

/** One scene-owned animation point. Its owner supplies actual update steps. */
export class SceneAnimationClock {
  private timeSeconds = 0;
  private frame = 0;
  private revision = 0;
  private disposed = false;
  private invalidating = false;
  private publishing = false;
  private stepping = false;
  private readonly subscribers = new Set<Subscriber>();

  get frameStamp(): number {
    return this.frame;
  }

  nowSeconds(): number {
    return this.timeSeconds;
  }

  subscribe(tick: (timeSeconds: number) => void, invalidated: () => void): () => void {
    if (this.disposed || this.invalidating) {
      invalidated();
      return () => {};
    }
    const subscriber = { revision: this.revision, tick, invalidated };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** No RAF/timer is created here. Publication follows the owner's authored update. */
  step(deltaSeconds: number, update: () => void): void {
    if (this.disposed) throw new Error("Scene animation clock is disposed");
    if (this.stepping || this.publishing || this.invalidating)
      throw new Error("Scene animation clock step is reentrant");
    if (
      !Number.isFinite(deltaSeconds) ||
      deltaSeconds <= 0 ||
      !Number.isFinite(this.timeSeconds + deltaSeconds) ||
      !Number.isSafeInteger(this.frame + 1)
    )
      throw new TypeError("Invalid scene animation clock step");
    this.stepping = true;
    try {
      const revision = this.revision;
      this.timeSeconds += deltaSeconds;
      this.frame++;
      update();
      if (this.disposed || revision !== this.revision) return;
      const batch = [...this.subscribers];
      const errors: unknown[] = [];
      this.publishing = true;
      try {
        for (const subscriber of batch) {
          if (this.disposed || revision !== this.revision) break;
          if (!this.subscribers.has(subscriber) || subscriber.revision !== revision) continue;
          try {
            subscriber.tick(this.timeSeconds);
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        this.publishing = false;
      }
      if (errors.length) throw new AggregateError(errors, "Scene animation clock subscriber failed");
    } finally {
      this.stepping = false;
    }
  }

  snapshot(): SceneAnimationClockSnapshot {
    return { version: 1, timeSeconds: this.timeSeconds, frame: this.frame };
  }

  restore(snapshot: SceneAnimationClockSnapshot): void {
    if (this.disposed) throw new Error("Scene animation clock is disposed");
    if (this.invalidating || this.stepping || this.publishing) throw new Error("Scene animation clock restore is reentrant");
    const { timeSeconds, frame } = SceneAnimationClock.validateSnapshot(snapshot);
    const errors = this.invalidate();
    if (this.disposed) throw new Error("Scene animation clock was disposed during restore");
    this.timeSeconds = timeSeconds;
    this.frame = frame;
    if (errors.length) throw new AggregateError(errors, "Scene animation clock invalidation failed");
  }

  static validateSnapshot(snapshot: SceneAnimationClockSnapshot): SceneAnimationClockSnapshot {
    if (
      !snapshot || snapshot.version !== 1 ||
      !Number.isFinite(snapshot.timeSeconds) ||
      snapshot.timeSeconds < 0 ||
      !Number.isSafeInteger(snapshot.frame) ||
      snapshot.frame < 0
    )
      throw new TypeError("Invalid scene animation clock snapshot");
    return { version: 1, timeSeconds: snapshot.timeSeconds, frame: snapshot.frame };
  }

  reset(): void {
    this.restore({ version: 1, timeSeconds: 0, frame: 0 });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.invalidating) return;
    const errors = this.invalidate();
    if (errors.length) throw new AggregateError(errors, "Scene animation clock invalidation failed");
  }

  private invalidate(): unknown[] {
    const previous = [...this.subscribers];
    this.subscribers.clear();
    this.revision++;
    this.invalidating = true;
    const errors: unknown[] = [];
    try {
      for (const subscriber of previous) {
        try {
          subscriber.invalidated();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.invalidating = false;
    }
    return errors;
  }
}
