import {
  AddEquation,
  BufferAttribute,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  OneFactor,
  RawShaderMaterial,
  SrcAlphaFactor,
  Texture,
  Vector2,
} from "three";
import type { AdvFrameEntry } from "@haneoka/vega/renderer-kit";
import { AdvRainSimulation, type AdvRainFrameSnapshot } from "./AdvRainSimulation";
export type { AdvRainFrameSnapshot } from "./AdvRainSimulation";

const vertex = `precision highp float;
attribute vec2 aCorner; attribute vec2 aPosition; attribute vec2 aSize;
attribute vec2 aRotation; attribute float aAlpha;
uniform vec2 uViewport; uniform vec2 uOffset; uniform float uAlpha;
varying vec2 vUv; varying float vAlpha;
void main() {
  vec2 local=aCorner*aSize;
  vec2 p=aPosition+uOffset+vec2(aRotation.x*local.x-aRotation.y*local.y,aRotation.y*local.x+aRotation.x*local.y);
  gl_Position=vec4(2.0*p.x/uViewport.x-1.0,1.0-2.0*p.y/uViewport.y,0.0,1.0);
  vUv=vec2(aCorner.x+0.5,0.5-aCorner.y);
  vAlpha=aAlpha*uAlpha;
}`;
const fragment = `precision highp float;
uniform sampler2D uTexture; varying vec2 vUv; varying float vAlpha;
void main() { vec4 texel=texture2D(uTexture,vUv);gl_FragColor=vec4(texel.rgb,texel.a*vAlpha); }
`;

export class AdvRainFrameRenderer {
  readonly simulation: AdvRainSimulation;
  readonly mesh: Mesh<InstancedBufferGeometry, RawShaderMaterial>;
  private readonly instances: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly viewport = new Vector2(1, 1);
  private readonly offset = new Vector2();
  private revision = -1;
  private paused = false;

  constructor(frame: AdvFrameEntry, texture: Texture, seed?: number) {
    this.simulation = new AdvRainSimulation(frame, seed);
    this.instances = new Float32Array(this.simulation.capacity * 7);
    this.buffer = new InstancedInterleavedBuffer(this.instances, 7).setUsage(DynamicDrawUsage);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      "aCorner",
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute("aPosition", new InterleavedBufferAttribute(this.buffer, 2, 0));
    geometry.setAttribute("aSize", new InterleavedBufferAttribute(this.buffer, 2, 2));
    geometry.setAttribute("aRotation", new InterleavedBufferAttribute(this.buffer, 2, 4));
    geometry.setAttribute("aAlpha", new InterleavedBufferAttribute(this.buffer, 1, 6));
    geometry.instanceCount = 0;
    const material = new RawShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uTexture: { value: texture },
        uViewport: { value: this.viewport },
        uOffset: { value: this.offset },
        uAlpha: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneFactor,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }
  setViewport(width: number, height: number): void {
    this.viewport.set(Math.max(1, width), Math.max(1, height));
    this.simulation.setViewport(width, height);
    this.sync();
  }
  setOffset(x: number, y: number): void {
    this.offset.set(x, y);
  }
  setOpacity(alpha: number): void {
    const opacity = Math.max(0, Math.min(1, alpha));
    this.mesh.material.uniforms.uAlpha!.value = opacity;
    this.mesh.visible = opacity > 0;
  }
  setPaused(paused: boolean): void {
    this.paused = paused;
  }
  update(deltaSeconds: number): void {
    if (!this.paused) this.simulation.update(deltaSeconds);
    this.sync();
  }
  snapshot(): AdvRainFrameSnapshot {
    return this.simulation.snapshot();
  }
  restore(snapshot: AdvRainFrameSnapshot): void {
    this.simulation.restore(snapshot);
    this.sync();
  }
  private sync(): void {
    if (this.revision === this.simulation.revision) return;
    this.revision = this.simulation.revision;
    const particles = this.simulation.liveParticles;
    for (let index = 0; index < particles.length; index++) {
      const p = particles[index]!,
        at = index * 7;
      this.instances[at] = p.x;
      this.instances[at + 1] = p.y;
      this.instances[at + 2] = p.width;
      this.instances[at + 3] = p.height;
      this.instances[at + 4] = p.rotationCos;
      this.instances[at + 5] = p.rotationSin;
      this.instances[at + 6] = p.alpha;
    }
    this.buffer.clearUpdateRanges();
    if (particles.length) this.buffer.addUpdateRange(0, particles.length * 7);
    this.buffer.needsUpdate = true;
    this.mesh.geometry.instanceCount = particles.length;
  }
  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
