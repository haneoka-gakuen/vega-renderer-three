/**
 * Small color-science primitives used by the ADV grading pipeline.
 *
 * The implementation is expressed from published sRGB, CIE xyY and CAT02
 * equations. It does not depend on an engine color-utility implementation.
 */

export type AdvLmsCoefficients = readonly [
  long: number,
  medium: number,
  short: number,
];

const D65_X = 0.3127;
const D65_Y = 0.329;
const MIN_CHROMATICITY = 0.000001;

/** CIECAT02 XYZ-to-cone-response transform. */
const CAT02 = [
  [0.7328, 0.4296, -0.1624],
  [-0.7036, 1.6975, 0.0061],
  [0.003, 0.0136, 0.9834],
] as const;

const finite = (value: unknown, fallback = 0): number => {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

/**
 * Relative xyY (Y=1) to CAT02 cone responses.
 *
 * CAT02 is a public color-appearance transform; the input conversion follows
 * the CIE xyY definition X=xY/y and Z=(1-x-y)Y/y.
 */
export function cieXyToCat02Lms(
  xValue: number,
  yValue: number,
): AdvLmsCoefficients {
  const x = finite(xValue, D65_X);
  const y = Math.max(MIN_CHROMATICITY, finite(yValue, D65_Y));
  const xyz = [x / y, 1, (1 - x - y) / y] as const;
  return CAT02.map(
    (row) =>
      row[0] * xyz[0] +
      row[1] * xyz[1] +
      row[2] * xyz[2],
  ) as unknown as AdvLmsCoefficients;
}

/**
 * CIE daylight-locus approximation for the y coordinate at a given x.
 *
 * The polynomial is the standard illuminant-series-D approximation. Keeping
 * it separate from the UI mapping makes the color science independently
 * testable.
 */
export function cieDaylightLocusY(xValue: number): number {
  const x = finite(xValue, D65_X);
  return -3 * x * x + 2.87 * x - 0.275;
}

const D65_LMS = cieXyToCat02Lms(D65_X, D65_Y);

/**
 * Map ADV's signed temperature/tint controls to a bounded daylight white and
 * return Von Kries scale factors in CAT02 space.
 *
 * The control mapping is renderer-owned: temperature moves symmetrically
 * along the daylight locus and tint moves across it. It deliberately avoids
 * copying another engine's asymmetric slider mapping.
 */
export function advColorBalanceLms(
  temperatureValue: number,
  tintValue: number,
): AdvLmsCoefficients {
  const temperature = clamp(finite(temperatureValue) / 100, -1, 1);
  const tint = clamp(finite(tintValue) / 100, -1, 1);
  const x = clamp(D65_X - temperature * 0.05, 0.2, 0.45);
  const daylightDelta =
    cieDaylightLocusY(x) - cieDaylightLocusY(D65_X);
  const y = clamp(D65_Y + daylightDelta + tint * 0.04, 0.2, 0.45);
  const target = cieXyToCat02Lms(x, y);
  return [
    D65_LMS[0] / target[0],
    D65_LMS[1] / target[1],
    D65_LMS[2] / target[2],
  ];
}
