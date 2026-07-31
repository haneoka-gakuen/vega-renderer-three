import {
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import { advColorBalanceLms } from "./ColorScience";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import { ADV_URP_COLOR_GRADING_LUT_SIZE } from "./AdvUrpMath";
import type { AdvUrpVolumeState } from "./AdvVolumeStack";
import {
  advLinearColor,
  bakeAdvTextureCurve,
  prepareAdvLiftGammaGain,
  prepareAdvSplitToning,
  prepareAdvTonalRanges,
} from "./ColorGradingMath";

// All five reference UniversalRenderPipelineAsset objects serialize
// m_ColorGradingLutSize=16. This is intentionally not URP's editor default.
const LUT_SIZE = ADV_URP_COLOR_GRADING_LUT_SIZE;
const LUT_WIDTH = LUT_SIZE * LUT_SIZE;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Original LUT implementation assembled from public color-space equations and
// the renderer's normalized ADV volume state.
const LUT_BUILDER_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec4 uLutParams;
uniform vec3 uColorBalance;
uniform vec3 uColorFilter;
uniform vec3 uChannelMixerRed;
uniform vec3 uChannelMixerGreen;
uniform vec3 uChannelMixerBlue;
uniform vec3 uHueSatCon;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uShadows;
uniform vec3 uMidtones;
uniform vec3 uHighlights;
uniform vec4 uShaHiLimits;
uniform vec4 uSplitShadows;
uniform vec3 uSplitHighlights;
uniform sampler2D tCurveMaster;
uniform sampler2D tCurveRed;
uniform sampler2D tCurveGreen;
uniform sampler2D tCurveBlue;
uniform sampler2D tCurveHueVsHue;
uniform sampler2D tCurveHueVsSat;
uniform sampler2D tCurveSatVsSat;
uniform sampler2D tCurveLumVsSat;
varying vec2 vUv;

float advLuminance(vec3 value) {
  return dot(value, vec3(0.212672904, 0.715152204, 0.0721750036));
}

float evaluateCurve(sampler2D curve, float value) {
  return clamp(texture2D(curve, vec2(value, 0.0)).r, 0.0, 1.0);
}

vec3 linearSrgbToXyz(vec3 color) {
  return vec3(
    dot(color, vec3(0.4123908, 0.35758434, 0.18048079)),
    dot(color, vec3(0.21263901, 0.71516868, 0.07219232)),
    dot(color, vec3(0.01933082, 0.11919478, 0.95053215))
  );
}

vec3 xyzToLinearSrgb(vec3 xyz) {
  return vec3(
    dot(xyz, vec3(3.24096994, -1.53738318, -0.49861076)),
    dot(xyz, vec3(-0.96924364, 1.87596750, 0.04155506)),
    dot(xyz, vec3(0.05563008, -0.20397696, 1.05697151))
  );
}

vec3 xyzToCat02(vec3 xyz) {
  return vec3(
    dot(xyz, vec3(0.7328, 0.4296, -0.1624)),
    dot(xyz, vec3(-0.7036, 1.6975, 0.0061)),
    dot(xyz, vec3(0.0030, 0.0136, 0.9834))
  );
}

vec3 cat02ToXyz(vec3 lms) {
  return vec3(
    dot(lms, vec3(1.096124, -0.278869, 0.182745)),
    dot(lms, vec3(0.454369, 0.473533, 0.072098)),
    dot(lms, vec3(-0.009628, -0.005698, 1.015326))
  );
}

float linearToSrgbChannel(float value) {
  float magnitude = abs(value);
  float encoded = magnitude <= 0.0031308
    ? 12.92 * magnitude
    : 1.055 * pow(magnitude, 1.0 / 2.4) - 0.055;
  return value < 0.0 ? -encoded : encoded;
}

float srgbToLinearChannel(float value) {
  float magnitude = abs(value);
  float linear = magnitude <= 0.04045
    ? magnitude / 12.92
    : pow((magnitude + 0.055) / 1.055, 2.4);
  return value < 0.0 ? -linear : linear;
}

float softLightChannel(float backdrop, float source) {
  if (source <= 0.5) {
    return backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop);
  }
  float d = backdrop <= 0.25
    ? ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop
    : sqrt(max(backdrop, 0.0));
  return backdrop + (2.0 * source - 1.0) * (d - backdrop);
}

vec3 softLight(vec3 backdrop, vec3 source) {
  return vec3(
    softLightChannel(backdrop.r, source.r),
    softLightChannel(backdrop.g, source.g),
    softLightChannel(backdrop.b, source.b)
  );
}

vec3 advRgbToHsv(vec3 color) {
  float maximum = max(color.r, max(color.g, color.b));
  float minimum = min(color.r, min(color.g, color.b));
  float delta = maximum - minimum;
  float hue = 0.0;
  if (delta > 0.000001) {
    if (maximum == color.r) {
      hue = mod((color.g - color.b) / delta, 6.0);
    } else if (maximum == color.g) {
      hue = (color.b - color.r) / delta + 2.0;
    } else {
      hue = (color.r - color.g) / delta + 4.0;
    }
    hue = fract(hue / 6.0);
  }
  float saturation = maximum <= 0.000001 ? 0.0 : delta / maximum;
  return vec3(hue, saturation, maximum);
}

vec3 advHsvToRgb(vec3 hsv) {
  float sector = fract(hsv.x) * 6.0;
  float chroma = hsv.z * hsv.y;
  float secondary = chroma * (1.0 - abs(mod(sector, 2.0) - 1.0));
  vec3 rgb;
  if (sector < 1.0) rgb = vec3(chroma, secondary, 0.0);
  else if (sector < 2.0) rgb = vec3(secondary, chroma, 0.0);
  else if (sector < 3.0) rgb = vec3(0.0, chroma, secondary);
  else if (sector < 4.0) rgb = vec3(0.0, secondary, chroma);
  else if (sector < 5.0) rgb = vec3(secondary, 0.0, chroma);
  else rgb = vec3(chroma, 0.0, secondary);
  return rgb + vec3(hsv.z - chroma);
}

vec3 lutStripValue(vec2 uv) {
  uv.x *= uLutParams.x;
  float base = floor(uv.x);
  uv.x -= base;
  vec3 color = vec3(uv - uLutParams.zz, base * 2.0 * uLutParams.z);
  return color * uLutParams.w;
}

void main() {
  vec3 color = lutStripValue(vUv);

  vec3 lms = xyzToCat02(linearSrgbToXyz(color));
  lms *= uColorBalance;
  color = xyzToLinearSrgb(cat02ToXyz(lms));
  float contrast = max(uHueSatCon.z, 0.001);
  color = vec3(0.18) * pow(max(color / 0.18, vec3(0.0)), vec3(contrast));
  color *= uColorFilter;
  color = max(color, 0.0);

  vec3 encodedColor = vec3(
    linearToSrgbChannel(color.r),
    linearToSrgbChannel(color.g),
    linearToSrgbChannel(color.b)
  );
  float splitWeight = clamp(advLuminance(min(encodedColor, 1.0)) + uSplitShadows.w, 0.0, 1.0);
  vec3 splitShadow = mix(vec3(0.5), uSplitShadows.rgb, 1.0 - splitWeight);
  vec3 splitHighlight = mix(vec3(0.5), uSplitHighlights, splitWeight);
  encodedColor = softLight(encodedColor, splitShadow);
  encodedColor = softLight(encodedColor, splitHighlight);
  color = vec3(
    srgbToLinearChannel(encodedColor.r),
    srgbToLinearChannel(encodedColor.g),
    srgbToLinearChannel(encodedColor.b)
  );

  color = vec3(
    dot(color, uChannelMixerRed),
    dot(color, uChannelMixerGreen),
    dot(color, uChannelMixerBlue)
  );

  float luma = advLuminance(color);
  float shadowT = clamp((luma - uShaHiLimits.x) / (uShaHiLimits.y - uShaHiLimits.x), 0.0, 1.0);
  float highlightT = clamp((luma - uShaHiLimits.z) / (uShaHiLimits.w - uShaHiLimits.z), 0.0, 1.0);
  float shadowFactor = 1.0 - shadowT * shadowT * (3.0 - 2.0 * shadowT);
  float highlightFactor = highlightT * highlightT * (3.0 - 2.0 * highlightT);
  float midtoneFactor = 1.0 - shadowFactor - highlightFactor;
  color = color * uShadows * shadowFactor
        + color * uMidtones * midtoneFactor
        + color * uHighlights * highlightFactor;

  color = color * uGain + uLift;
  color = sign(color) * pow(abs(color), uGamma);

  vec3 hsv = advRgbToHsv(color);
  float originalHue = abs(hsv.x);
  float originalSaturation = hsv.y;
  float originalLuminance = advLuminance(color);
  float hueForCurve = originalHue + uHueSatCon.x;
  float hueOffset = evaluateCurve(tCurveHueVsHue, hueForCurve) - 0.5;
  hsv.x = fract(hueForCurve + hueOffset);
  color = advHsvToRgb(hsv);

  float satMultiplier = evaluateCurve(tCurveHueVsSat, originalHue) * 2.0;
  satMultiplier *= evaluateCurve(tCurveSatVsSat, originalSaturation) * 2.0;
  satMultiplier *= evaluateCurve(tCurveLumVsSat, originalLuminance) * 2.0;
  luma = advLuminance(color);
  color = vec3(luma) + (uHueSatCon.y * satMultiplier) * (color - vec3(luma));

  const float halfPixel = 0.5 / 128.0;
  vec3 masterInput = color + halfPixel;
  color = vec3(
    evaluateCurve(tCurveMaster, masterInput.r),
    evaluateCurve(tCurveMaster, masterInput.g),
    evaluateCurve(tCurveMaster, masterInput.b)
  );
  vec3 rgbInput = color + halfPixel;
  color = vec3(
    evaluateCurve(tCurveRed, rgbInput.r),
    evaluateCurve(tCurveGreen, rgbInput.g),
    evaluateCurve(tCurveBlue, rgbInput.b)
  );
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

type LutUniforms = Record<string, IUniform<unknown>> & {
  uLutParams: IUniform<Vector4>;
  uColorBalance: IUniform<Vector3>;
  uColorFilter: IUniform<Vector3>;
  uChannelMixerRed: IUniform<Vector3>;
  uChannelMixerGreen: IUniform<Vector3>;
  uChannelMixerBlue: IUniform<Vector3>;
  uHueSatCon: IUniform<Vector3>;
  uLift: IUniform<Vector3>;
  uGamma: IUniform<Vector3>;
  uGain: IUniform<Vector3>;
  uShadows: IUniform<Vector3>;
  uMidtones: IUniform<Vector3>;
  uHighlights: IUniform<Vector3>;
  uShaHiLimits: IUniform<Vector4>;
  uSplitShadows: IUniform<Vector4>;
  uSplitHighlights: IUniform<Vector3>;
  tCurveMaster: IUniform<Texture | null>;
  tCurveRed: IUniform<Texture | null>;
  tCurveGreen: IUniform<Texture | null>;
  tCurveBlue: IUniform<Texture | null>;
  tCurveHueVsHue: IUniform<Texture | null>;
  tCurveHueVsSat: IUniform<Texture | null>;
  tCurveSatVsSat: IUniform<Texture | null>;
  tCurveLumVsSat: IUniform<Texture | null>;
};

function vector3(value: readonly number[]): Vector3 {
  return new Vector3(value[0], value[1], value[2]);
}

export class AdvColorGradingLut {
  private readonly target = new WebGLRenderTarget(LUT_WIDTH, LUT_SIZE, {
    depthBuffer: false,
    stencilBuffer: false,
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  private readonly uniforms: LutUniforms = {
    uLutParams: { value: new Vector4(LUT_SIZE, 0.5 / LUT_WIDTH, 0.5 / LUT_SIZE, LUT_SIZE / (LUT_SIZE - 1)) },
    uColorBalance: { value: new Vector3(1, 1, 1) },
    uColorFilter: { value: new Vector3(1, 1, 1) },
    uChannelMixerRed: { value: new Vector3(1, 0, 0) },
    uChannelMixerGreen: { value: new Vector3(0, 1, 0) },
    uChannelMixerBlue: { value: new Vector3(0, 0, 1) },
    uHueSatCon: { value: new Vector3(0, 1, 1) },
    uLift: { value: new Vector3() },
    uGamma: { value: new Vector3(1, 1, 1) },
    uGain: { value: new Vector3(1, 1, 1) },
    uShadows: { value: new Vector3(1, 1, 1) },
    uMidtones: { value: new Vector3(1, 1, 1) },
    uHighlights: { value: new Vector3(1, 1, 1) },
    uShaHiLimits: { value: new Vector4(0, 0.3, 0.55, 1) },
    uSplitShadows: { value: new Vector4(0.5, 0.5, 0.5, 0) },
    uSplitHighlights: { value: new Vector3(0.5, 0.5, 0.5) },
    tCurveMaster: { value: null },
    tCurveRed: { value: null },
    tCurveGreen: { value: null },
    tCurveBlue: { value: null },
    tCurveHueVsHue: { value: null },
    tCurveHueVsSat: { value: null },
    tCurveSatVsSat: { value: null },
    tCurveLumVsSat: { value: null },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: LUT_BUILDER_FRAGMENT,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
  private curveTextures: Texture[] = [];
  private lastFingerprint = "";
  private lastState: Readonly<AdvUrpVolumeState> | null = null;

  constructor() {
    this.target.texture.name = "adv-urp-internal-ldr-lut-16";
    this.target.texture.colorSpace = NoColorSpace;
    this.target.texture.generateMipmaps = false;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  render(state: Readonly<AdvUrpVolumeState>, renderFullscreen: AdvRenderFullscreen): Texture {
    // AdvUrpPostProcessor replaces the resolved volume state whenever a layer
    // changes. The common frame path keeps the same immutable state object, so
    // avoid rebuilding and serializing a grading projection every frame.
    if (state === this.lastState) return this.target.texture;
    const grading = {
      splitToning: state.splitToning,
      colorAdjustments: state.colorAdjustments,
      whiteBalance: state.whiteBalance,
      liftGammaGain: state.liftGammaGain,
      shadowsMidtonesHighlights: state.shadowsMidtonesHighlights,
      channelMixer: state.channelMixer,
      colorCurves: state.colorCurves,
    };
    const fingerprint = JSON.stringify(grading);
    if (fingerprint === this.lastFingerprint) {
      this.lastState = state;
      return this.target.texture;
    }

    const balance = advColorBalanceLms(
      state.whiteBalance.temperature,
      state.whiteBalance.tint,
    );
    this.uniforms.uColorBalance.value.set(...balance);
    const linearFilter = advLinearColor(state.colorAdjustments.colorFilter);
    this.uniforms.uColorFilter.value.set(linearFilter[0], linearFilter[1], linearFilter[2]);
    const mixer = state.channelMixer;
    this.uniforms.uChannelMixerRed.value.set(
      mixer.redOutRedIn / 100,
      mixer.redOutGreenIn / 100,
      mixer.redOutBlueIn / 100,
    );
    this.uniforms.uChannelMixerGreen.value.set(
      mixer.greenOutRedIn / 100,
      mixer.greenOutGreenIn / 100,
      mixer.greenOutBlueIn / 100,
    );
    this.uniforms.uChannelMixerBlue.value.set(
      mixer.blueOutRedIn / 100,
      mixer.blueOutGreenIn / 100,
      mixer.blueOutBlueIn / 100,
    );
    this.uniforms.uHueSatCon.value.set(
      state.colorAdjustments.hueShift / 360,
      state.colorAdjustments.saturation / 100 + 1,
      state.colorAdjustments.contrast / 100 + 1,
    );

    const [shadows, midtones, highlights] = prepareAdvTonalRanges(
      state.shadowsMidtonesHighlights.shadows,
      state.shadowsMidtonesHighlights.midtones,
      state.shadowsMidtonesHighlights.highlights,
    );
    this.uniforms.uShadows.value.copy(vector3(shadows));
    this.uniforms.uMidtones.value.copy(vector3(midtones));
    this.uniforms.uHighlights.value.copy(vector3(highlights));
    this.uniforms.uShaHiLimits.value.set(
      state.shadowsMidtonesHighlights.shadowsStart,
      state.shadowsMidtonesHighlights.shadowsEnd,
      state.shadowsMidtonesHighlights.highlightsStart,
      state.shadowsMidtonesHighlights.highlightsEnd,
    );

    const [lift, gamma, gain] = prepareAdvLiftGammaGain(
      state.liftGammaGain.lift,
      state.liftGammaGain.gamma,
      state.liftGammaGain.gain,
    );
    this.uniforms.uLift.value.copy(vector3(lift));
    this.uniforms.uGamma.value.copy(vector3(gamma));
    this.uniforms.uGain.value.copy(vector3(gain));

    const [splitShadows, splitHighlights] = prepareAdvSplitToning(
      state.splitToning.shadows,
      state.splitToning.highlights,
      state.splitToning.balance,
    );
    this.uniforms.uSplitShadows.value.set(...splitShadows);
    this.uniforms.uSplitHighlights.value.copy(vector3(splitHighlights));

    for (const texture of this.curveTextures) texture.dispose();
    const curves = state.colorCurves;
    this.curveTextures = [
      bakeAdvTextureCurve(curves.master),
      bakeAdvTextureCurve(curves.red),
      bakeAdvTextureCurve(curves.green),
      bakeAdvTextureCurve(curves.blue),
      bakeAdvTextureCurve(curves.hueVsHue),
      bakeAdvTextureCurve(curves.hueVsSat),
      bakeAdvTextureCurve(curves.satVsSat),
      bakeAdvTextureCurve(curves.lumVsSat),
    ];
    [
      this.uniforms.tCurveMaster,
      this.uniforms.tCurveRed,
      this.uniforms.tCurveGreen,
      this.uniforms.tCurveBlue,
      this.uniforms.tCurveHueVsHue,
      this.uniforms.tCurveHueVsSat,
      this.uniforms.tCurveSatVsSat,
      this.uniforms.tCurveLumVsSat,
    ].forEach((uniform, index) => {
      uniform.value = this.curveTextures[index];
    });
    renderFullscreen(this.material, this.target, true);
    this.lastFingerprint = fingerprint;
    this.lastState = state;
    return this.target.texture;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    for (const texture of this.curveTextures) texture.dispose();
    this.curveTextures = [];
  }
}
