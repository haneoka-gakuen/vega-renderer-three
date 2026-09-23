import {
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RepeatWrapping,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import type { AdvBloomResult, AdvRenderFullscreen } from "./AdvUrpBloom";
import { advFilmGrainTextureReference } from "./AdvFilmGrainAssets";
import type { AdvUrpVolumeState } from "./AdvVolumeStack";
import { UnityRandom } from "../particles/UnityParticleMath";

export type AdvPostTextureUsage = "color-lookup" | "film-grain" | "lens-dirt";

/**
 * Synchronous bridge for host- or plugin-owned textures. The renderer never
 * downloads opaque URLs or bundles material textures of its own.
 */
export type AdvPostTextureResolver = (reference: unknown, usage: AdvPostTextureUsage) => Texture | null;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Original portable post-composite shader. It intentionally uses compact,
 * documented transforms rather than extracted engine programs.
 */
export const ADV_UBER_POST_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D tInput;
uniform sampler2D tBloom;
uniform sampler2D tLut;
uniform sampler2D tGrain;
uniform sampler2D tUserLut;
uniform sampler2D tLensDirt;
uniform vec2 uInputTexelSize;
uniform vec2 uBloomTexelSize;
uniform vec3 uLutParams;
uniform float uPostExposure;
uniform vec4 uBloomParams;
uniform vec4 uDistortion1;
uniform vec4 uDistortion2;
uniform float uChromaAmount;
uniform vec4 uVignette1;
uniform vec4 uVignette2;
uniform vec2 uGrainParams;
uniform vec2 uGrainSeed;
uniform vec2 uGrainScale;
uniform vec4 uUserLutParams;
uniform vec4 uLensDirtParams;
uniform float uLensDirtIntensity;
uniform float uTonemapping;
uniform float uHdrGrading;
uniform float uUseDistortion;
uniform float uUseChromatic;
uniform float uUseBloom;
uniform float uUseVignette;
uniform float uUseGrain;
uniform float uUseGrainTexture;
uniform float uUseUserLut;
uniform float uUseLensDirt;
varying vec2 vUv;

vec2 clampBilinear(vec2 uv, vec2 texelSize) {
  return clamp(uv, texelSize * 0.5, vec2(1.0) - texelSize * 0.5);
}

float srgbToLinearChannel(float value) {
  return value <= 0.04045
    ? value / 12.92
    : pow((value + 0.055) / 1.055, 2.4);
}

vec3 srgbToLinear(vec3 value) {
  return vec3(
    srgbToLinearChannel(value.r),
    srgbToLinearChannel(value.g),
    srgbToLinearChannel(value.b)
  );
}

float linearToSrgbChannel(float value) {
  value = max(value, 0.0);
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

vec3 linearToSrgb(vec3 value) {
  return vec3(
    linearToSrgbChannel(value.r),
    linearToSrgbChannel(value.g),
    linearToSrgbChannel(value.b)
  );
}

vec2 distortUv(vec2 uv) {
  if (uUseDistortion < 0.5) return uv;
  vec2 centered = (uv - 0.5) * uDistortion2.z;
  vec2 radial = uDistortion1.zw * (centered - uDistortion1.xy);
  float radius = length(radial);
  if (radius < 0.00001) return centered + 0.5;
  float signedAmount = uDistortion2.w;
  float warped = signedAmount >= 0.0
    ? tan(radius * uDistortion2.x) / max(radius * uDistortion2.y, 0.00001)
    : uDistortion2.x * atan(radius * uDistortion2.y) / radius;
  return centered + 0.5 + radial * (warped - 1.0);
}

vec3 sampleLut2D(sampler2D lut, vec3 params, vec3 color) {
  color = clamp(color, 0.0, 1.0);
  float blue = color.b * params.z;
  float slice = min(floor(blue), params.z - 1.0);
  vec2 uv = color.rg * params.z * params.xy + params.xy * 0.5;
  uv.x += slice * params.y;
  vec3 left = texture2D(lut, uv).rgb;
  vec3 right = texture2D(lut, uv + vec2(params.y, 0.0)).rgb;
  return mix(left, right, blue - slice);
}

vec3 neutralToneMap(vec3 color) {
  return color / (vec3(1.0) + max(color, vec3(0.0)));
}

vec3 filmicToneMap(vec3 color) {
  color = max(color, vec3(0.0));
  vec3 shaped = color * (vec3(1.0) + color * 0.12)
    / (vec3(1.0) + color * 0.02);
  return vec3(1.0) - exp(-shaped);
}

vec3 encodeHdrLutInput(vec3 color) {
  const float range = 16.0;
  return log2(vec3(1.0) + clamp(color, 0.0, range)) / log2(1.0 + range);
}

vec3 applyUserLut(vec3 linearColor) {
  if (uUseUserLut < 0.5 || uUserLutParams.w <= 0.0) return linearColor;
  vec3 srgb = clamp(linearToSrgb(linearColor), 0.0, 1.0);
  vec3 graded = sampleLut2D(tUserLut, uUserLutParams.xyz, srgb);
  return srgbToLinear(mix(srgb, graded, uUserLutParams.w));
}

float proceduralNoise(vec2 uv) {
  vec2 p = floor(uv * vec2(1024.0)) + uGrainSeed * 4096.0;
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  vec2 distortedUv = distortUv(uv);
  vec4 source = texture2D(tInput, clampBilinear(distortedUv, uInputTexelSize));
  vec3 color = srgbToLinear(source.rgb);
  vec3 unprocessed = color;

  if (uUseChromatic > 0.5) {
    vec2 centered = 2.0 * uv - 1.0;
    vec2 delta = -centered * dot(centered, centered) * uChromaAmount / 3.0;
    color.r = srgbToLinearChannel(
      texture2D(tInput, clampBilinear(distortUv(uv - delta), uInputTexelSize)).r
    );
    color.b = srgbToLinearChannel(
      texture2D(tInput, clampBilinear(distortUv(uv + delta), uInputTexelSize)).b
    );
  }

  if (uUseBloom > 0.5) {
    vec3 bloom = max(
      texture2D(tBloom, clampBilinear(distortedUv, uBloomTexelSize)).rgb,
      vec3(0.0)
    );
    // The gamma-space URP bloom pyramid stores encoded samples. Unity's
    // UberPost decodes them with the same fast gamma approximation before
    // composing them into the scene-linear color buffer.
    bloom *= bloom;
    bloom *= uBloomParams.x * uBloomParams.yzw;
    color += bloom;
    if (uUseLensDirt > 0.5) {
      vec3 dirt = texture2D(
        tLensDirt,
        uv * uLensDirtParams.xy + uLensDirtParams.zw
      ).rgb;
      color += bloom * dirt * uLensDirtIntensity;
    }
  }

  if (uUseVignette > 0.5 && uVignette2.z > 0.0) {
    vec2 radius = abs(distortedUv - uVignette2.xy) * uVignette2.z;
    radius.x *= uVignette1.w;
    float mask = pow(
      clamp(1.0 - dot(radius, radius), 0.0, 1.0),
      max(uVignette2.w, 0.0001)
    );
    color *= mix(uVignette1.rgb, vec3(1.0), mask);
  }

  color *= uPostExposure;
  if (uHdrGrading > 0.5) {
    color = sampleLut2D(tLut, uLutParams, encodeHdrLutInput(color));
  } else {
    if (uTonemapping > 1.5) color = filmicToneMap(color);
    else if (uTonemapping > 0.5) color = neutralToneMap(color);
    else color = clamp(color, 0.0, 1.0);
    color = sampleLut2D(tLut, uLutParams, color);
  }
  color = applyUserLut(color);

  if (uUseGrain > 0.5) {
    float noise = uUseGrainTexture > 0.5
      ? texture2D(tGrain, uv * uGrainScale + uGrainSeed).a
      : proceduralNoise(uv);
    noise = noise * 2.0 - 1.0;
    float luminance = dot(color, vec3(0.212672904, 0.715152204, 0.0721750036));
    float response = mix(1.0, 1.0 - sqrt(clamp(luminance, 0.0, 1.0)), uGrainParams.y);
    color += color * noise * uGrainParams.x * response;
  }

  vec3 outputColor = linearToSrgb(max(color, vec3(0.0)));
  vec3 originalColor = linearToSrgb(max(unprocessed, vec3(0.0)));
  outputColor = mix(originalColor, outputColor, clamp(source.a, 0.0, 1.0));
  gl_FragColor = vec4(outputColor, clamp(source.a, 0.0, 1.0));
}
`;

type UberUniforms = Record<string, IUniform<unknown>> & {
  tInput: IUniform<Texture | null>;
  tBloom: IUniform<Texture | null>;
  tLut: IUniform<Texture | null>;
  tGrain: IUniform<Texture | null>;
  tUserLut: IUniform<Texture | null>;
  tLensDirt: IUniform<Texture | null>;
  uInputTexelSize: IUniform<Vector2>;
  uBloomTexelSize: IUniform<Vector2>;
  uLutParams: IUniform<Vector3>;
  uPostExposure: IUniform<number>;
  uBloomParams: IUniform<Vector4>;
  uDistortion1: IUniform<Vector4>;
  uDistortion2: IUniform<Vector4>;
  uChromaAmount: IUniform<number>;
  uVignette1: IUniform<Vector4>;
  uVignette2: IUniform<Vector4>;
  uGrainParams: IUniform<Vector2>;
  uGrainSeed: IUniform<Vector2>;
  uGrainScale: IUniform<Vector2>;
  uUserLutParams: IUniform<Vector4>;
  uLensDirtParams: IUniform<Vector4>;
  uLensDirtIntensity: IUniform<number>;
  uTonemapping: IUniform<number>;
  uHdrGrading: IUniform<number>;
  uUseDistortion: IUniform<number>;
  uUseChromatic: IUniform<number>;
  uUseBloom: IUniform<number>;
  uUseVignette: IUniform<number>;
  uUseGrain: IUniform<number>;
  uUseGrainTexture: IUniform<number>;
  uUseUserLut: IUniform<number>;
  uUseLensDirt: IUniform<number>;
};

/** Letterbox-style texture scale and offset for a full-screen lens-dirt map. */
export const advLensDirtScaleOffset = (
  screenWidth: number,
  screenHeight: number,
  dirtWidth: number,
  dirtHeight: number,
): readonly [number, number, number, number] => {
  const screenRatio = screenWidth / screenHeight;
  const dirtRatio = dirtWidth / dirtHeight;
  if (dirtRatio > screenRatio) {
    const scale = screenRatio / dirtRatio;
    return [scale, 1, (1 - scale) * 0.5, 0];
  }
  if (dirtRatio < screenRatio) {
    const scale = dirtRatio / screenRatio;
    return [1, scale, 0, (1 - scale) * 0.5];
  }
  return [1, 1, 0, 0];
};

export const advUserLutParams = (
  width: number,
  height: number,
  contribution: number,
): readonly [number, number, number, number] => [
  1 / width,
  1 / height,
  height - 1,
  Math.max(0, Math.min(1, contribution)),
];

/** Logarithmic 0..16 scene-linear encoding shared with the authored HDR LUT. */
export const advHdrLutInput = (value: number): number => {
  const bounded = Math.max(0, Math.min(16, Number.isFinite(value) ? value : 0));
  return Math.log2(1 + bounded) / Math.log2(17);
};

/** @deprecated Use `advFilmGrainTextureReference` for all preset slots. */
export const advFilmGrainTextureUrl = (type: number, customTextureReference: unknown): string | null =>
  Math.trunc(type) === 10 && typeof customTextureReference === "string" ? customTextureReference || null : null;

export class AdvUrpUberPost {
  private readonly uniforms: UberUniforms = {
    tInput: { value: null },
    tBloom: { value: null },
    tLut: { value: null },
    tGrain: { value: null },
    tUserLut: { value: null },
    tLensDirt: { value: null },
    uInputTexelSize: { value: new Vector2(1, 1) },
    uBloomTexelSize: { value: new Vector2(1, 1) },
    uLutParams: { value: new Vector3(1 / 256, 1 / 16, 15) },
    uPostExposure: { value: 1 },
    uBloomParams: { value: new Vector4() },
    uDistortion1: { value: new Vector4(0, 0, 1, 1) },
    uDistortion2: { value: new Vector4(1, 1, 1, 0) },
    uChromaAmount: { value: 0 },
    uVignette1: { value: new Vector4(0, 0, 0, 1) },
    uVignette2: { value: new Vector4(0.5, 0.5, 0, 1) },
    uGrainParams: { value: new Vector2() },
    uGrainSeed: { value: new Vector2() },
    uGrainScale: { value: new Vector2(1, 1) },
    uUserLutParams: { value: new Vector4(1, 1, 0, 0) },
    uLensDirtParams: { value: new Vector4(1, 1, 0, 0) },
    uLensDirtIntensity: { value: 0 },
    uTonemapping: { value: 0 },
    uHdrGrading: { value: 0 },
    uUseDistortion: { value: 0 },
    uUseChromatic: { value: 0 },
    uUseBloom: { value: 0 },
    uUseVignette: { value: 0 },
    uUseGrain: { value: 0 },
    uUseGrainTexture: { value: 0 },
    uUseUserLut: { value: 0 },
    uUseLensDirt: { value: 0 },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: ADV_UBER_POST_FRAGMENT,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });

  constructor(private readonly resolveTexture?: AdvPostTextureResolver) {}

  render(
    source: WebGLRenderTarget,
    destination: WebGLRenderTarget,
    state: Readonly<AdvUrpVolumeState>,
    lut: Texture,
    bloom: AdvBloomResult | null,
    hdrGrading: boolean,
    frameCount: number,
    renderFullscreen: AdvRenderFullscreen,
  ): void {
    source.texture.minFilter = LinearFilter;
    source.texture.magFilter = LinearFilter;
    this.uniforms.tInput.value = source.texture;
    this.uniforms.uInputTexelSize.value.set(1 / source.width, 1 / source.height);
    this.uniforms.tLut.value = lut;
    this.uniforms.uPostExposure.value = 2 ** state.colorAdjustments.postExposure;

    this.uniforms.uUseBloom.value = bloom ? 1 : 0;
    this.uniforms.tBloom.value = bloom?.texture ?? source.texture;
    this.uniforms.uBloomTexelSize.value.set(1 / (bloom?.width ?? source.width), 1 / (bloom?.height ?? source.height));
    this.uniforms.uBloomParams.value.set(
      bloom?.intensity ?? 0,
      bloom?.tint[0] ?? 1,
      bloom?.tint[1] ?? 1,
      bloom?.tint[2] ?? 1,
    );

    const dirtRequested = Boolean(bloom && state.bloom.dirtIntensity > 0 && state.bloom.dirtTexture != null);
    const dirt = dirtRequested ? this.resolveExternalTexture(state.bloom.dirtTexture, "lens-dirt") : null;
    const dirtImage = dirt?.image as { readonly width?: unknown; readonly height?: unknown } | undefined;
    const dirtWidth = Number(dirtImage?.width);
    const dirtHeight = Number(dirtImage?.height);
    const dirtSizeValid = Number.isFinite(dirtWidth) && dirtWidth > 0 && Number.isFinite(dirtHeight) && dirtHeight > 0;
    const dirtActive = Boolean(dirt && dirtSizeValid);
    this.uniforms.uUseLensDirt.value = dirtActive ? 1 : 0;
    this.uniforms.tLensDirt.value = dirt ?? source.texture;
    this.uniforms.uLensDirtIntensity.value = dirtActive ? Math.max(0, state.bloom.dirtIntensity) : 0;
    if (dirtActive) {
      const screenRatio = source.width / source.height;
      const dirtRatio = dirtWidth / dirtHeight;
      if (dirtRatio > screenRatio) {
        const scale = screenRatio / dirtRatio;
        this.uniforms.uLensDirtParams.value.set(scale, 1, (1 - scale) * 0.5, 0);
      } else if (dirtRatio < screenRatio) {
        const scale = dirtRatio / screenRatio;
        this.uniforms.uLensDirtParams.value.set(1, scale, 0, (1 - scale) * 0.5);
      } else {
        this.uniforms.uLensDirtParams.value.set(1, 1, 0, 0);
      }
    }

    const userLutRequested =
      state.colorLookup.active && state.colorLookup.contribution > 0 && state.colorLookup.texture != null;
    const userLut = userLutRequested ? this.resolveExternalTexture(state.colorLookup.texture, "color-lookup") : null;
    const userLutImage = userLut?.image as { readonly width?: unknown; readonly height?: unknown } | undefined;
    const userLutWidth = Number(userLutImage?.width);
    const userLutHeight = Number(userLutImage?.height);
    const userLutActive = Boolean(
      userLut &&
      Number.isFinite(userLutWidth) &&
      Number.isFinite(userLutHeight) &&
      userLutWidth > 0 &&
      userLutHeight > 0 &&
      userLutWidth === userLutHeight * userLutHeight,
    );
    this.uniforms.uUseUserLut.value = userLutActive ? 1 : 0;
    this.uniforms.tUserLut.value = userLut ?? lut;
    if (userLutActive) {
      this.uniforms.uUserLutParams.value.set(
        1 / userLutWidth,
        1 / userLutHeight,
        userLutHeight - 1,
        Math.max(0, Math.min(1, state.colorLookup.contribution)),
      );
    }

    this.uniforms.uHdrGrading.value = hdrGrading ? 1 : 0;
    this.uniforms.uTonemapping.value = !hdrGrading && state.tonemapping.active ? Math.trunc(state.tonemapping.mode) : 0;

    const distortion = state.lensDistortion;
    const distortionActive = distortion.active && Math.abs(distortion.intensity) > 0;
    this.uniforms.uUseDistortion.value = distortionActive ? 1 : 0;
    if (distortionActive) {
      const amount = 1.6 * Math.max(Math.abs(distortion.intensity * 100), 1);
      const theta = (Math.PI / 180) * Math.min(160, amount);
      const sigma = 2 * Math.tan(theta * 0.5);
      this.uniforms.uDistortion1.value.set(
        distortion.center.x * 2 - 1,
        distortion.center.y * 2 - 1,
        Math.max(distortion.xMultiplier, 0.0001),
        Math.max(distortion.yMultiplier, 0.0001),
      );
      this.uniforms.uDistortion2.value.set(
        distortion.intensity >= 0 ? theta : 1 / theta,
        sigma,
        1 / Math.max(0.0001, distortion.scale),
        distortion.intensity,
      );
    }

    this.uniforms.uUseChromatic.value =
      state.chromaticAberration.active && state.chromaticAberration.intensity > 0 ? 1 : 0;
    this.uniforms.uChromaAmount.value = Math.max(0, state.chromaticAberration.intensity) * 0.05;

    const vignette = state.vignette;
    this.uniforms.uUseVignette.value = vignette.active && vignette.intensity > 0 ? 1 : 0;
    this.uniforms.uVignette1.value.set(
      vignette.color.r ?? vignette.color.x ?? 0,
      vignette.color.g ?? vignette.color.y ?? 0,
      vignette.color.b ?? vignette.color.z ?? 0,
      vignette.rounded ? source.width / source.height : 1,
    );
    this.uniforms.uVignette2.value.set(
      vignette.center.x,
      vignette.center.y,
      vignette.intensity * 3,
      Math.max(0.001, vignette.smoothness * 5),
    );

    const grain = state.filmGrain;
    const grainRequested = grain.active && grain.intensity > 0;
    const grainType = Math.trunc(Number(grain.type));
    const grainReference = grainRequested ? advFilmGrainTextureReference(grainType, grain.texture) : null;
    const grainTexture = grainReference === null ? null : this.resolveExternalTexture(grainReference, "film-grain");
    const grainActive = grainRequested && (grainType !== 10 || grainTexture !== null);
    this.uniforms.uUseGrain.value = grainActive ? 1 : 0;
    this.uniforms.uUseGrainTexture.value = grainActive && grainTexture ? 1 : 0;
    this.uniforms.tGrain.value = grainTexture ?? source.texture;
    if (grainActive) {
      this.uniforms.uGrainParams.value.set(Math.max(0, grain.intensity) * 4, Math.max(0, Math.min(1, grain.response)));
      const image = grainTexture?.image as { width?: number; height?: number } | undefined;
      this.uniforms.uGrainScale.value.set(
        source.width / Math.max(1, Number(image?.width) || 512),
        source.height / Math.max(1, Number(image?.height) || 512),
      );
      const random = new UnityRandom(frameCount);
      this.uniforms.uGrainSeed.value.set(random.next(), random.next());
    }

    renderFullscreen(this.material, destination, true);
  }

  dispose(): void {
    this.material.dispose();
  }

  private resolveExternalTexture(reference: unknown, usage: AdvPostTextureUsage): Texture | null {
    const texture = reference instanceof Texture ? reference : (this.resolveTexture?.(reference, usage) ?? null);
    if (!texture) return null;
    texture.colorSpace = NoColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    if (usage === "film-grain") {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
    }
    return texture;
  }
}
