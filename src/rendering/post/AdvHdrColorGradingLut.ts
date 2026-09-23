import {
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import { AdvColorGradingLut } from "./AdvColorGradingLut";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import { ADV_URP_COLOR_GRADING_LUT_SIZE } from "./AdvUrpMath";
import type { AdvUrpVolumeState } from "./AdvVolumeStack";

const LUT_SIZE = ADV_URP_COLOR_GRADING_LUT_SIZE;
const LUT_WIDTH = LUT_SIZE * LUT_SIZE;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Original HDR adapter: decode the renderer's bounded logarithmic scene
 * space, apply a compact tone curve, then reuse the authored LDR grading LUT.
 */
export const ADV_HDR_LUT_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D tLdrLut;
uniform float uToneMode;
uniform vec4 uLutParams;
varying vec2 vUv;

vec3 stripValue(vec2 uv) {
  float scaledX = uv.x * uLutParams.x;
  float blueSlice = floor(scaledX);
  float red = fract(scaledX);
  float green = uv.y;
  return clamp(vec3(red, green, blueSlice / (uLutParams.x - 1.0)), 0.0, 1.0);
}

vec3 decodeHdr(vec3 encoded) {
  const float range = 16.0;
  return exp2(encoded * log2(1.0 + range)) - vec3(1.0);
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

vec3 sampleLut2D(sampler2D lut, vec3 color) {
  color = clamp(color, 0.0, 1.0);
  float blue = color.b * uLutParams.z;
  float slice = min(floor(blue), uLutParams.z - 1.0);
  vec2 texel = uLutParams.yw;
  vec2 uv = color.rg * uLutParams.z * texel + texel * 0.5;
  uv.x += slice * texel.y;
  vec3 left = texture2D(lut, uv).rgb;
  vec3 right = texture2D(lut, uv + vec2(texel.y, 0.0)).rgb;
  return mix(left, right, blue - slice);
}

void main() {
  vec3 color = decodeHdr(stripValue(vUv));
  if (uToneMode > 1.5) color = filmicToneMap(color);
  else if (uToneMode > 0.5) color = neutralToneMap(color);
  else color = clamp(color, 0.0, 1.0);
  gl_FragColor = vec4(sampleLut2D(tLdrLut, color), 1.0);
}
`;

type HdrUniforms = Record<string, IUniform<unknown>> & {
  tLdrLut: IUniform<Texture | null>;
  uToneMode: IUniform<number>;
  uLutParams: IUniform<{ readonly x: number; readonly y: number; readonly z: number; readonly w: number }>;
};

export const advHdrToneMap = (value: number, mode: number): number => {
  const color = Math.max(0, Number.isFinite(value) ? value : 0);
  if (Math.trunc(mode) >= 2) {
    const shaped = (color * (1 + color * 0.12)) / (1 + color * 0.02);
    return Math.max(0, Math.min(1, 1 - Math.exp(-shaped)));
  }
  if (Math.trunc(mode) === 1) return color / (1 + color);
  return Math.min(1, color);
};

export class AdvHdrColorGradingLut {
  private readonly ldr = new AdvColorGradingLut();
  private readonly target = new WebGLRenderTarget(LUT_WIDTH, LUT_SIZE, {
    depthBuffer: false,
    stencilBuffer: false,
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  private readonly uniforms: HdrUniforms = {
    tLdrLut: { value: null },
    uToneMode: { value: 0 },
    uLutParams: {
      value: {
        x: LUT_SIZE,
        y: 1 / LUT_WIDTH,
        z: LUT_SIZE - 1,
        w: 1 / LUT_SIZE,
      },
    },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: ADV_HDR_LUT_FRAGMENT,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
  private lastState: Readonly<AdvUrpVolumeState> | null = null;
  private lastToneMode = Number.NaN;

  constructor() {
    this.target.texture.name = "adv-portable-internal-hdr-lut-16";
    this.target.texture.colorSpace = NoColorSpace;
    this.target.texture.generateMipmaps = false;
  }

  render(state: Readonly<AdvUrpVolumeState>, renderFullscreen: AdvRenderFullscreen): Texture {
    const ldrTexture = this.ldr.render(state, renderFullscreen);
    const toneMode = state.tonemapping.active ? Math.trunc(state.tonemapping.mode) : 0;
    if (state === this.lastState && toneMode === this.lastToneMode) {
      return this.target.texture;
    }
    this.uniforms.tLdrLut.value = ldrTexture;
    this.uniforms.uToneMode.value = toneMode;
    renderFullscreen(this.material, this.target, true);
    this.lastState = state;
    this.lastToneMode = toneMode;
    return this.target.texture;
  }

  dispose(): void {
    this.ldr.dispose();
    this.target.dispose();
    this.material.dispose();
  }
}
