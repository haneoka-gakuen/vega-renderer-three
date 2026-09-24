import type { AdvFrameAnimation, StoryFrameLayout } from "@haneoka/vega/renderer-kit";

interface CurveKey {
  readonly time: number;
  readonly coefficients: readonly [number, number, number, number];
}

function decodeWords(encoded: string): Uint32Array {
  if (encoded.length > 1_000_000) throw new TypeError("Frame animation is too large");
  const raw = atob(encoded);
  if (raw.length % 4) throw new TypeError("Frame animation has invalid byte length");
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  const view = new DataView(buffer);
  return Uint32Array.from({ length: raw.length / 4 }, (_, index) => view.getUint32(index * 4, true));
}

function floatBits(word: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, word, true);
  return view.getFloat32(0, true);
}

function parseCurves(animation: AdvFrameAnimation): readonly CurveKey[][] {
  const count = Math.trunc(animation.streamedCurveCount);
  if (count < 0 || count > 4096) throw new TypeError("Invalid frame animation curve count");
  const curves = Array.from({ length: count }, () => [] as CurveKey[]);
  const words = decodeWords(animation.stream);
  let cursor = 0;
  while (cursor + 2 <= words.length) {
    const time = floatBits(words[cursor++]!);
    const keyCount = words[cursor++]!;
    if (keyCount > count || cursor + keyCount * 5 > words.length) break;
    for (let index = 0; index < keyCount; index += 1) {
      const curve = words[cursor++]!;
      const coefficients = [
        floatBits(words[cursor++]!),
        floatBits(words[cursor++]!),
        floatBits(words[cursor++]!),
        floatBits(words[cursor++]!),
      ] as const;
      curves[curve]?.push({ time, coefficients });
    }
  }
  return curves;
}

export class NativeFrameAnimator {
  private readonly curves: readonly CurveKey[][];
  private readonly nodesById: ReadonlyMap<string, number>;

  constructor(
    private readonly layout: StoryFrameLayout,
    private readonly animation: AdvFrameAnimation,
  ) {
    if (!(animation.duration > 0) || animation.bindings.length > 4096) {
      throw new TypeError("Invalid frame animation");
    }
    this.curves = parseCurves(animation);
    this.nodesById = new Map(layout.nodes.map((node, index) => [node.id, index]));
  }

  private value(curve: number, time: number): number | undefined {
    if (curve >= this.animation.streamedCurveCount) {
      return this.animation.constantValues[curve - this.animation.streamedCurveCount];
    }
    const keys = this.curves[curve];
    if (!keys?.length) return undefined;
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (keys[middle]!.time <= time) low = middle + 1;
      else high = middle;
    }
    const key = keys[Math.max(0, low - 1)]!;
    const delta = time - key.time;
    const [a, b, c, d] = key.coefficients;
    return ((a * delta + b) * delta + c) * delta + d;
  }

  sample(elapsed: number): StoryFrameLayout {
    const duration = this.animation.duration;
    const time = this.animation.loop
      ? ((Math.max(0, elapsed) % duration) + duration) % duration
      : Math.max(0, Math.min(duration, elapsed));
    const changes = new Map<
      number,
      Record<string, number | readonly [number, number] | readonly [number, number, number, number] | boolean>
    >();
    for (const binding of this.animation.bindings) {
      const index = this.nodesById.get(binding.node);
      if (index === undefined) continue;
      const node = this.layout.nodes[index]!;
      const value = this.value(binding.curve, time);
      if (value === undefined || !Number.isFinite(value)) continue;
      const change = changes.get(index) ?? {};
      changes.set(index, change);
      switch (binding.property) {
        case "opacity":
          change.opacity = Math.max(0, Math.min(1, value));
          break;
        case "positionX":
          change.position = [value, (change.position as readonly number[] | undefined)?.[1] ?? node.position[1]];
          break;
        case "positionY":
          change.position = [(change.position as readonly number[] | undefined)?.[0] ?? node.position[0], value];
          break;
        case "sizeX":
          change.size = [value, (change.size as readonly number[] | undefined)?.[1] ?? node.size[1]];
          break;
        case "sizeY":
          change.size = [(change.size as readonly number[] | undefined)?.[0] ?? node.size[0], value];
          break;
        case "scale": {
          const y = this.value(binding.curve + 1, time);
          change.scale = [value, y !== undefined && Number.isFinite(y) ? y : node.scale[1]];
          break;
        }
        case "active":
          change.active = value >= 0.5;
          break;
        case "imageR":
        case "imageG":
        case "imageB": {
          if (!node.image) break;
          const color = [...((change.imageColor as readonly number[] | undefined) ?? node.image.color)] as [
            number,
            number,
            number,
            number,
          ];
          color[binding.property === "imageR" ? 0 : binding.property === "imageG" ? 1 : 2] = value;
          change.imageColor = color;
          break;
        }
      }
    }
    return {
      ...this.layout,
      nodes: this.layout.nodes.map((node, index) => {
        const change = changes.get(index);
        if (!change) return node;
        const { imageColor, ...fields } = change;
        return {
          ...node,
          ...fields,
          ...(imageColor && node.image ? { image: { ...node.image, color: imageColor } } : {}),
        } as typeof node;
      }),
    };
  }
}
