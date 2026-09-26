export interface SharedTextureLease<Value> {
  readonly value: Value;
  readonly kind: "active" | "warm";
  release(): void;
}

interface TextureCacheEntry<Value> {
  readonly promise: Promise<Value>;
  readonly controller: AbortController;
  activeReferences: number;
  warmReferences: number;
  value: Value | undefined;
  byteSize: number;
  lastIdleTick: number;
  disposeOnIdle: boolean;
}

export interface SharedTextureCacheStats {
  readonly entries: number;
  readonly activeReferences: number;
  readonly warmReferences: number;
  readonly activeEntries: number;
  readonly warmEntries: number;
  readonly idleEntries: number;
  readonly liveBytes: number;
  readonly activeBytes: number;
  readonly warmBytes: number;
}

/** Reference-counted async cache with entry-count and GPU-byte bounded idle LRU. */
export class SharedTextureResourceCache<Key, Value> {
  private readonly entries = new Map<Key, TextureCacheEntry<Value>>();
  private readonly load: (key: Key, signal: AbortSignal) => Promise<Value>;
  private readonly dispose: (value: Value) => void;
  private readonly sizeOf: (value: Value) => number;
  private maximumIdleEntries: number;
  private maximumBytes: number;
  private tick = 0;

  constructor(
    load: (key: Key, signal: AbortSignal) => Promise<Value>,
    dispose: (value: Value) => void,
    maximumIdleEntries = 48,
    maximumBytes = Number.POSITIVE_INFINITY,
    sizeOf: (value: Value) => number = () => 0,
  ) {
    this.load = load;
    this.dispose = dispose;
    this.sizeOf = sizeOf;
    this.maximumIdleEntries = this.normalizeLimit(maximumIdleEntries);
    this.maximumBytes = this.normalizeByteLimit(maximumBytes);
  }

  configure(maximumIdleEntries: number, maximumBytes = this.maximumBytes): void {
    this.maximumIdleEntries = this.normalizeLimit(maximumIdleEntries);
    this.maximumBytes = this.normalizeByteLimit(maximumBytes);
    this.trimIdleEntries();
  }

  async acquire(
    key: Key,
    signal?: AbortSignal,
    kind: "active" | "warm" = "active",
  ): Promise<SharedTextureLease<Value>> {
    if (signal?.aborted) throw this.abortError();
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: TextureCacheEntry<Value> = {
        promise: Promise.resolve().then(() => this.load(key, controller.signal)),
        controller,
        activeReferences: 0,
        warmReferences: 0,
        value: undefined,
        byteSize: 0,
        lastIdleTick: 0,
        disposeOnIdle: false,
      };
      created.promise.then(
        (value) => {
          created.value = value;
          created.byteSize = this.normalizeByteSize(this.sizeOf(value));
          if (this.entries.get(key) !== created) {
            this.dispose(value);
            return;
          }
          if (this.totalReferences(created) === 0 && created.disposeOnIdle) this.disposeEntry(key, created);
          else this.trimIdleEntries();
        },
        () => {
          if (this.entries.get(key) === created) this.entries.delete(key);
        },
      );
      this.entries.set(key, created);
      entry = created;
    }

    this.addReference(entry, kind);
    let value: Value;
    try {
      value = await this.waitForEntry(entry, signal);
    } catch (error) {
      this.release(key, entry, kind);
      throw error;
    }

    let released = false;
    return {
      value,
      kind,
      release: () => {
        if (released) return;
        released = true;
        this.release(key, entry, kind);
      },
    };
  }

  async warm(key: Key, signal?: AbortSignal): Promise<Value> {
    const lease = await this.acquire(key, signal, "warm");
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
      if (this.totalReferences(entry) === 0 && entry.value !== undefined) this.disposeEntry(key, entry);
      else if (this.totalReferences(entry) === 0) this.cancelPendingEntry(key, entry);
    }
  }

  disposeAllWhenIdle(): void {
    this.disposeWhenIdle([...this.entries.keys()]);
  }

  get stats(): SharedTextureCacheStats {
    let activeReferences = 0;
    let warmReferences = 0;
    let activeEntries = 0;
    let warmEntries = 0;
    let idleEntries = 0;
    let liveBytes = 0;
    let activeBytes = 0;
    let warmBytes = 0;
    for (const entry of this.entries.values()) {
      activeReferences += entry.activeReferences;
      warmReferences += entry.warmReferences;
      if (entry.activeReferences > 0) {
        activeEntries += 1;
        activeBytes += entry.byteSize;
      }
      if (entry.warmReferences > 0) {
        warmEntries += 1;
        warmBytes += entry.byteSize;
      }
      if (this.totalReferences(entry) === 0 && entry.value !== undefined) idleEntries += 1;
      if (entry.value !== undefined) liveBytes += entry.byteSize;
    }
    return {
      entries: this.entries.size,
      activeReferences,
      warmReferences,
      activeEntries,
      warmEntries,
      idleEntries,
      liveBytes,
      activeBytes,
      warmBytes,
    };
  }

  private addReference(entry: TextureCacheEntry<Value>, kind: "active" | "warm"): void {
    if (kind === "active") entry.activeReferences += 1;
    else entry.warmReferences += 1;
  }

  private release(key: Key, entry: TextureCacheEntry<Value>, kind: "active" | "warm"): void {
    if (kind === "active") {
      if (entry.activeReferences <= 0) return;
      entry.activeReferences -= 1;
    } else {
      if (entry.warmReferences <= 0) return;
      entry.warmReferences -= 1;
    }
    if (this.totalReferences(entry) !== 0 || this.entries.get(key) !== entry) return;
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
        return this.totalReferences(entry[1]) === 0 && entry[1].value !== undefined;
      })
      .sort((left, right) => left[1].lastIdleTick - right[1].lastIdleTick);
    let liveBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.value !== undefined) liveBytes += entry.byteSize;
    }
    let index = 0;
    while (index < idle.length && (idle.length - index > this.maximumIdleEntries || liveBytes > this.maximumBytes)) {
      const [key, entry] = idle[index];
      index += 1;
      if (this.entries.get(key) === entry && this.totalReferences(entry) === 0) {
        liveBytes -= entry.byteSize;
        this.disposeEntry(key, entry);
      }
    }
  }

  private disposeEntry(key: Key, entry: TextureCacheEntry<Value>): void {
    if (this.entries.get(key) !== entry || this.totalReferences(entry) !== 0 || entry.value === undefined) return;
    this.entries.delete(key);
    this.dispose(entry.value);
  }

  private cancelPendingEntry(key: Key, entry: TextureCacheEntry<Value>): void {
    if (this.entries.get(key) !== entry || this.totalReferences(entry) !== 0 || entry.value !== undefined) return;
    this.entries.delete(key);
    entry.disposeOnIdle = true;
    entry.controller.abort();
  }

  private totalReferences(entry: TextureCacheEntry<Value>): number {
    return entry.activeReferences + entry.warmReferences;
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

  private normalizeByteLimit(value: number): number {
    const limit = Number(value);
    return Number.isFinite(limit) ? Math.max(0, limit) : Number.POSITIVE_INFINITY;
  }

  private normalizeByteSize(value: number): number {
    const size = Number(value);
    return Number.isFinite(size) && size > 0 ? size : 0;
  }
}
