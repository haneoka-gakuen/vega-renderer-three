export interface SharedTextureLease<Value> {
  readonly value: Value;
  release(): void;
}

interface TextureCacheEntry<Value> {
  readonly promise: Promise<Value>;
  readonly controller: AbortController;
  references: number;
  value: Value | undefined;
  lastIdleTick: number;
  disposeOnIdle: boolean;
}

export interface SharedTextureCacheStats {
  readonly entries: number;
  readonly activeReferences: number;
  readonly idleEntries: number;
}

/** Reference-counted async cache with a configurable, bounded idle LRU. */
export class SharedTextureResourceCache<Key, Value> {
  private readonly entries = new Map<Key, TextureCacheEntry<Value>>();
  private readonly load: (key: Key, signal: AbortSignal) => Promise<Value>;
  private readonly dispose: (value: Value) => void;
  private maximumIdleEntries: number;
  private tick = 0;

  constructor(
    load: (key: Key, signal: AbortSignal) => Promise<Value>,
    dispose: (value: Value) => void,
    maximumIdleEntries = 48,
  ) {
    this.load = load;
    this.dispose = dispose;
    this.maximumIdleEntries = this.normalizeLimit(maximumIdleEntries);
  }

  configure(maximumIdleEntries: number): void {
    this.maximumIdleEntries = this.normalizeLimit(maximumIdleEntries);
    this.trimIdleEntries();
  }

  async acquire(key: Key, signal?: AbortSignal): Promise<SharedTextureLease<Value>> {
    if (signal?.aborted) throw this.abortError();
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: TextureCacheEntry<Value> = {
        promise: Promise.resolve().then(() => this.load(key, controller.signal)),
        controller,
        references: 0,
        value: undefined,
        lastIdleTick: 0,
        disposeOnIdle: false,
      };
      created.promise.then(
        (value) => {
          created.value = value;
          if (this.entries.get(key) !== created) {
            this.dispose(value);
            return;
          }
          if (created.references === 0 && created.disposeOnIdle) this.disposeEntry(key, created);
        },
        () => {
          if (this.entries.get(key) === created) this.entries.delete(key);
        },
      );
      this.entries.set(key, created);
      entry = created;
    }

    entry.references += 1;
    let value: Value;
    try {
      value = await this.waitForEntry(entry, signal);
    } catch (error) {
      this.release(key, entry);
      throw error;
    }

    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        this.release(key, entry);
      },
    };
  }

  async warm(key: Key, signal?: AbortSignal): Promise<Value> {
    const lease = await this.acquire(key, signal);
    const value = lease.value;
    lease.release();
    return value;
  }

  /** Dispose listed entries now, or immediately after their final owner releases. */
  disposeWhenIdle(keys: Iterable<Key>): void {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      entry.disposeOnIdle = true;
      if (entry.references === 0 && entry.value !== undefined) this.disposeEntry(key, entry);
      else if (entry.references === 0) this.cancelPendingEntry(key, entry);
    }
  }

  disposeAllWhenIdle(): void {
    this.disposeWhenIdle([...this.entries.keys()]);
  }

  get stats(): SharedTextureCacheStats {
    let activeReferences = 0;
    let idleEntries = 0;
    for (const entry of this.entries.values()) {
      activeReferences += entry.references;
      if (entry.references === 0 && entry.value !== undefined) idleEntries += 1;
    }
    return { entries: this.entries.size, activeReferences, idleEntries };
  }

  private release(key: Key, entry: TextureCacheEntry<Value>): void {
    if (entry.references <= 0) return;
    entry.references -= 1;
    if (entry.references !== 0 || this.entries.get(key) !== entry) return;
    if (entry.value === undefined) {
      this.cancelPendingEntry(key, entry);
      return;
    }
    if (entry.disposeOnIdle && entry.value !== undefined) {
      this.disposeEntry(key, entry);
      return;
    }
    entry.lastIdleTick = this.tick += 1;
    this.trimIdleEntries();
  }

  private trimIdleEntries(): void {
    const idle = [...this.entries.entries()]
      .filter((entry): entry is [Key, TextureCacheEntry<Value>] => {
        return entry[1].references === 0 && entry[1].value !== undefined;
      })
      .sort((left, right) => left[1].lastIdleTick - right[1].lastIdleTick);
    for (let index = 0; index < idle.length - this.maximumIdleEntries; index += 1) {
      const [key, entry] = idle[index];
      if (this.entries.get(key) === entry && entry.references === 0) this.disposeEntry(key, entry);
    }
  }

  private disposeEntry(key: Key, entry: TextureCacheEntry<Value>): void {
    if (this.entries.get(key) !== entry || entry.references !== 0 || entry.value === undefined) return;
    this.entries.delete(key);
    this.dispose(entry.value);
  }

  private cancelPendingEntry(key: Key, entry: TextureCacheEntry<Value>): void {
    if (this.entries.get(key) !== entry || entry.references !== 0 || entry.value !== undefined) return;
    this.entries.delete(key);
    entry.disposeOnIdle = true;
    entry.controller.abort();
  }

  private waitForEntry(entry: TextureCacheEntry<Value>, signal?: AbortSignal): Promise<Value> {
    if (!signal) return entry.promise;
    if (signal.aborted) return Promise.reject(this.abortError());
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => finish(() => reject(this.abortError()));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      entry.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private abortError(): Error {
    const error = new Error("Texture loading was aborted");
    error.name = "AbortError";
    return error;
  }

  private normalizeLimit(value: number): number {
    const limit = Number(value);
    return Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 48;
  }
}
