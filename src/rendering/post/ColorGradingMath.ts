import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RedFormat,
} from "three";
import type {
  UnityColorValue,
  UnityCurveKeyframe,
  UnityTextureCurve,
} from "./AdvVolumeStack";

export type AdvColorVector4 = readonly [
  red: number,
  green: number,
  blue: number,
  scalar: number,
];

type Rgb = readonly [red: number, green: number, blue: number];

/** Linear-sRGB Y row, derived from the sRGB primaries and D65 white. */
const LINEAR_SRGB_LUMINANCE = [
  0.21263900587151036,
  0.7151686787677559,
  0.07219231536073371,
] as const;

const CURVE_TEXTURE_WIDTH = 128;

const finite = (value: unknown, fallback = 0): number => {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
};

const finiteOrInfinite = (value: unknown, fallback = 0): number => {
  const candidate = Number(value);
  return Number.isNaN(candidate) ? fallback : candidate;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const cleanNearZero = (value: number): number =>
  Math.abs(value) <= 1e-12 ? 0 : value;

/** Extended sRGB electro-optical transfer function from CSS Color 4. */
export function srgbToLinear(channelValue: number): number {
  const channel = finite(channelValue);
  const sign = channel < 0 ? -1 : 1;
  const magnitude = Math.abs(channel);
  if (magnitude <= 0.04045) return channel / 12.92;
  return (
    sign *
    Math.pow((magnitude + 0.055) / 1.055, 2.4)
  );
}

export function advLinearColor(color: UnityColorValue): AdvColorVector4 {
  return [
    srgbToLinear(finite(color.r ?? color.x, 1)),
    srgbToLinear(finite(color.g ?? color.y, 1)),
    srgbToLinear(finite(color.b ?? color.z, 1)),
    finite(color.a ?? color.w, 1),
  ];
}

export function linearSrgbLuminance(value: readonly number[]): number {
  return (
    finite(value[0]) * LINEAR_SRGB_LUMINANCE[0] +
    finite(value[1]) * LINEAR_SRGB_LUMINANCE[1] +
    finite(value[2]) * LINEAR_SRGB_LUMINANCE[2]
  );
}

const trackball = (value: UnityColorValue): AdvColorVector4 => [
  finite(value.r ?? value.x, 1),
  finite(value.g ?? value.y, 1),
  finite(value.b ?? value.z, 1),
  finite(value.a ?? value.w),
];

const trackballChroma = (
  value: UnityColorValue,
): { readonly chroma: Rgb; readonly scalar: number } => {
  const source = trackball(value);
  const linear = source.slice(0, 3).map(srgbToLinear) as unknown as Rgb;
  const luminance = linearSrgbLuminance(linear);
  return {
    chroma: [
      linear[0] - luminance,
      linear[1] - luminance,
      linear[2] - luminance,
    ],
    scalar: source[3],
  };
};

/**
 * Prepare multiplicative shadows/midtones/highlights controls.
 *
 * The hue component is luminance-neutral and the scalar component is an
 * exposure stop, yielding a symmetric and stable renderer-owned mapping.
 */
export function prepareAdvTonalRanges(
  shadowsInput: UnityColorValue,
  midtonesInput: UnityColorValue,
  highlightsInput: UnityColorValue,
): readonly [AdvColorVector4, AdvColorVector4, AdvColorVector4] {
  const prepare = (input: UnityColorValue): AdvColorVector4 => {
    const { chroma, scalar } = trackballChroma(input);
    const level = Math.pow(2, clamp(scalar, -4, 4));
    return [
      Math.max(0, level + chroma[0] * 0.5),
      Math.max(0, level + chroma[1] * 0.5),
      Math.max(0, level + chroma[2] * 0.5),
      0,
    ];
  };
  return [
    prepare(shadowsInput),
    prepare(midtonesInput),
    prepare(highlightsInput),
  ];
}

/**
 * Prepare additive lift, power gamma and multiplicative gain vectors.
 *
 * This is an original mapping onto conventional lift/gamma/gain operations:
 * alpha is measured in stops and RGB contributes a luminance-neutral tint.
 */
export function prepareAdvLiftGammaGain(
  liftInput: UnityColorValue,
  gammaInput: UnityColorValue,
  gainInput: UnityColorValue,
): readonly [AdvColorVector4, AdvColorVector4, AdvColorVector4] {
  const liftSource = trackballChroma(liftInput);
  const liftLevel = clamp(liftSource.scalar, -4, 4) * 0.25;
  const lift: AdvColorVector4 = [
    cleanNearZero(liftLevel + liftSource.chroma[0] * 0.25),
    cleanNearZero(liftLevel + liftSource.chroma[1] * 0.25),
    cleanNearZero(liftLevel + liftSource.chroma[2] * 0.25),
    0,
  ];

  const gammaSource = trackballChroma(gammaInput);
  const gammaBase = Math.pow(2, -clamp(gammaSource.scalar, -4, 4));
  const gamma: AdvColorVector4 = [
    Math.max(0.001, gammaBase * Math.pow(2, -gammaSource.chroma[0] * 0.5)),
    Math.max(0.001, gammaBase * Math.pow(2, -gammaSource.chroma[1] * 0.5)),
    Math.max(0.001, gammaBase * Math.pow(2, -gammaSource.chroma[2] * 0.5)),
    0,
  ];

  const gainSource = trackballChroma(gainInput);
  const gainBase = Math.pow(2, clamp(gainSource.scalar, -4, 4));
  const gain: AdvColorVector4 = [
    Math.max(0, gainBase * Math.pow(2, gainSource.chroma[0] * 0.5)),
    Math.max(0, gainBase * Math.pow(2, gainSource.chroma[1] * 0.5)),
    Math.max(0, gainBase * Math.pow(2, gainSource.chroma[2] * 0.5)),
    0,
  ];

  return [lift, gamma, gain];
}

/**
 * Pack split-toning colors in sRGB, as consumed by the standards-based
 * soft-light stage in the LUT shader.
 */
export function prepareAdvSplitToning(
  shadows: UnityColorValue,
  highlights: UnityColorValue,
  balanceValue: number,
): readonly [AdvColorVector4, AdvColorVector4] {
  return [
    [
      finite(shadows.r ?? shadows.x, 0.5),
      finite(shadows.g ?? shadows.y, 0.5),
      finite(shadows.b ?? shadows.z, 0.5),
      clamp(finite(balanceValue) / 100, -1, 1),
    ],
    [
      finite(highlights.r ?? highlights.x, 0.5),
      finite(highlights.g ?? highlights.y, 0.5),
      finite(highlights.b ?? highlights.z, 0.5),
      0,
    ],
  ];
}

const normalizedCurveKeys = (
  curve: UnityTextureCurve,
): UnityCurveKeyframe[] =>
  [...(curve.m_Curve?.m_Curve ?? [])]
    .map((key) => ({
      time: finite(key.time),
      value: finite(key.value),
      inSlope: finiteOrInfinite(key.inSlope),
      outSlope: finiteOrInfinite(key.outSlope),
      weightedMode: finite(key.weightedMode),
      inWeight: finite(key.inWeight, 1 / 3),
      outWeight: finite(key.outWeight, 1 / 3),
    }))
    .sort((left, right) => left.time - right.time);

const sampleHermite = (
  left: UnityCurveKeyframe,
  right: UnityCurveKeyframe,
  time: number,
): number => {
  const duration = right.time - left.time;
  if (!(duration > 0)) return right.value;
  const amount = clamp((time - left.time) / duration, 0, 1);
  const squared = amount * amount;
  const cubed = squared * amount;
  return (
    (2 * cubed - 3 * squared + 1) * left.value +
    (cubed - 2 * squared + amount) * duration * left.outSlope +
    (-2 * cubed + 3 * squared) * right.value +
    (cubed - squared) * duration * right.inSlope
  );
};

const sampleCubicBezier = (
  start: number,
  firstControl: number,
  secondControl: number,
  end: number,
  amount: number,
): number => {
  const inverse = 1 - amount;
  return (
    inverse * inverse * inverse * start +
    3 * inverse * inverse * amount * firstControl +
    3 * inverse * amount * amount * secondControl +
    amount * amount * amount * end
  );
};

const sampleWeightedSegment = (
  left: UnityCurveKeyframe,
  right: UnityCurveKeyframe,
  time: number,
): number => {
  const duration = right.time - left.time;
  if (!(duration > 0)) return right.value;
  if (!Number.isFinite(left.outSlope) || !Number.isFinite(right.inSlope)) {
    return left.value;
  }
  const leftWeight =
    (finite(left.weightedMode) & 2) !== 0
      ? clamp(finite(left.outWeight, 1 / 3), 0, 1)
      : 1 / 3;
  const rightWeight =
    (finite(right.weightedMode) & 1) !== 0
      ? clamp(finite(right.inWeight, 1 / 3), 0, 1)
      : 1 / 3;
  const x1 = left.time + duration * leftWeight;
  const x2 = right.time - duration * rightWeight;
  const y1 = left.value + left.outSlope * duration * leftWeight;
  const y2 = right.value - right.inSlope * duration * rightWeight;

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 28; iteration += 1) {
    const midpoint = (low + high) * 0.5;
    if (
      sampleCubicBezier(left.time, x1, x2, right.time, midpoint) <
      time
    ) {
      low = midpoint;
    } else {
      high = midpoint;
    }
  }
  return sampleCubicBezier(
    left.value,
    y1,
    y2,
    right.value,
    (low + high) * 0.5,
  );
};

const positiveModulo = (value: number, modulus: number): number =>
  ((value % modulus) + modulus) % modulus;

const wrapCurveTime = (
  time: number,
  first: number,
  last: number,
  mode: number,
): number => {
  const duration = last - first;
  if (!(duration > 0)) return first;
  if (mode === 2) return first + positiveModulo(time - first, duration);
  if (mode === 4) {
    const position = positiveModulo(time - first, duration * 2);
    return (
      first +
      (position <= duration ? position : duration * 2 - position)
    );
  }
  return clamp(time, first, last);
};

/** Evaluate the serialized ADV texture-curve representation. */
export function evaluateAdvTextureCurve(
  curve: UnityTextureCurve,
  timeValue: number,
): number {
  const source = normalizedCurveKeys(curve);
  if (source.length === 0) return finite(curve.m_ZeroValue);
  if (source.length === 1) return source[0]!.value;

  const range = Math.max(Number.EPSILON, finite(curve.m_Range, 1));
  const keys = curve.m_Loop
    ? [
        {
          ...source[source.length - 1]!,
          time: source[source.length - 1]!.time - range,
        },
        ...source,
        { ...source[0]!, time: source[0]!.time + range },
      ]
    : source;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  let time = finite(timeValue, first.time);
  if (time < first.time) {
    time = wrapCurveTime(
      time,
      first.time,
      last.time,
      finite(curve.m_Curve?.m_PreInfinity),
    );
  } else if (time > last.time) {
    time = wrapCurveTime(
      time,
      first.time,
      last.time,
      finite(curve.m_Curve?.m_PostInfinity),
    );
  }
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;

  for (let index = 0; index < keys.length - 1; index += 1) {
    const left = keys[index]!;
    const right = keys[index + 1]!;
    if (time < left.time || time > right.time) continue;
    if (time === right.time) return right.value;
    if (!Number.isFinite(left.outSlope) || !Number.isFinite(right.inSlope)) {
      return left.value;
    }
    const weighted =
      (finite(left.weightedMode) & 2) !== 0 ||
      (finite(right.weightedMode) & 1) !== 0;
    return weighted
      ? sampleWeightedSegment(left, right, time)
      : sampleHermite(left, right, time);
  }
  return last.value;
}

/** Bake the renderer's fixed-width half-float curve lookup texture. */
export function bakeAdvTextureCurve(curve: UnityTextureCurve): DataTexture {
  const data = new Uint16Array(CURVE_TEXTURE_WIDTH);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = DataUtils.toHalfFloat(
      evaluateAdvTextureCurve(curve, index / CURVE_TEXTURE_WIDTH),
    );
  }
  const texture = new DataTexture(
    data,
    CURVE_TEXTURE_WIDTH,
    1,
    RedFormat,
    HalfFloatType,
  );
  texture.name = "ADV texture curve 128 R16F";
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}
