import {
  Mesh,
  NormalBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  WebGLRenderer,
} from "three";
import type { IUniform } from "three";
import type { AdvRuleTransitionRenderState } from "./AdvRuleTransition";

const VERTEX_SHADER = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Screen-space FrontCanvas transition material. */
export const UNITY_RULE_TRANSITION_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uRuleTexture;
uniform vec2 uScreenSize;
uniform vec4 uColor;
uniform float uValue;
uniform int uUseGradient;

void main() {
  float alpha;
  if (uUseGradient != 0) {
    vec2 screenUv = gl_FragCoord.xy / uScreenSize.xy;
    float rule = texture2D(uRuleTexture, screenUv).x;
    float threshold = uValue * 0.600000024 + 0.400000006;
    float t = clamp((rule - threshold) * 5.0, 0.0, 1.0);
    alpha = t * t * (t * -2.0 + 3.0);
  } else {
    float t = clamp((1.0 - uValue) * 0.5, 0.0, 1.0);
    alpha = t * t * (t * -2.0 + 3.0);
  }
  gl_FragColor = vec4(uColor.rgb, alpha * uColor.a);
  gl_FragColor = sRGBTransferOETF(gl_FragColor);
}
`;

interface TransitionUniforms extends Record<string, IUniform<unknown>> {
  readonly uRuleTexture: IUniform<AdvRuleTransitionRenderState["texture"] | null>;
  readonly uScreenSize: IUniform<Vector2>;
  readonly uColor: IUniform<Vector4>;
  readonly uValue: IUniform<number>;
  readonly uUseGradient: IUniform<number>;
}

/** FrontCanvas rule Image rendered in the shared story context. */
export class AdvRuleTransitionPass {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly uniforms: TransitionUniforms = {
    uRuleTexture: { value: null },
    uScreenSize: { value: new Vector2(1, 1) },
    uColor: { value: new Vector4(0, 0, 0, 1) },
    uValue: { value: 1 },
    uUseGradient: { value: 0 },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: UNITY_RULE_TRANSITION_FRAGMENT_SHADER,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NormalBlending,
    transparent: true,
    toneMapped: false,
  });
  private readonly quad = new Mesh(this.geometry, this.material);
  private readonly drawingBufferSize = new Vector2();
  private disposed = false;

  constructor(private readonly renderer: WebGLRenderer) {
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  render(state: AdvRuleTransitionRenderState | null): void {
    if (this.disposed || !state?.visible) {
      this.uniforms.uRuleTexture.value = null;
      return;
    }
    this.uniforms.uRuleTexture.value = state.texture;
    this.uniforms.uColor.value.set(state.color.r, state.color.g, state.color.b, state.colorAlpha);
    this.uniforms.uValue.value = state.value;
    this.uniforms.uUseGradient.value = state.useGradient ? 1 : 0;
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    this.uniforms.uScreenSize.value.copy(this.drawingBufferSize);
    const target = this.renderer.getRenderTarget(),
      autoClear = this.renderer.autoClear;
    try {
      this.renderer.autoClear = false;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
      this.renderer.setRenderTarget(target);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.scene.remove(this.quad);
    this.uniforms.uRuleTexture.value = null;
    this.geometry.dispose();
    this.material.dispose();
    this.disposed = true;
  }
}
