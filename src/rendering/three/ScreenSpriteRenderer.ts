import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  BufferAttribute,
  LinearFilter,
  Matrix4,
  Mesh,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  Texture,
  Vector2,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import type { StoryScreenSpriteBatch } from "@haneoka/vega/renderer-kit";
const vertex = `precision highp float;
attribute vec2 aCorner;attribute vec2 aPosition;attribute float aRotation;attribute vec2 aScale;attribute float aAlpha;attribute vec4 aFrame;
uniform vec2 uSize;uniform mat4 uProjection;uniform vec3 uTint;
varying vec2 vUv;varying vec4 vColor;
void main(){vec2 local=aCorner*uSize*aScale;float c=cos(aRotation),s=sin(aRotation);vec2 p=aPosition+vec2(c*local.x-s*local.y,s*local.x+c*local.y);
gl_Position=uProjection*vec4(p,0.0,1.0);
vUv=mix(aFrame.xy,aFrame.zw,aCorner+0.5);vColor=vec4(floor(uTint*255.0*aAlpha+0.5),floor(aAlpha*255.0))/255.0;}`;
const fragment = `precision highp float;uniform sampler2D uTexture;varying vec2 vUv;varying vec4 vColor;void main(){gl_FragColor=texture2D(uTexture,vUv)*vColor;}`;
interface View {
  batch: StoryScreenSpriteBatch;
  mesh: Mesh<InstancedBufferGeometry, RawShaderMaterial>;
  buffer: InstancedInterleavedBuffer;
  revision: number;
  texture: Texture;
  projection: Matrix4;
  transform: Matrix4;
}
interface ImageTexture {
  texture: Texture;
  references: number;
}
export class ScreenSpriteRenderer {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly views = new Map<StoryScreenSpriteBatch, View>();
  private readonly images = new Map<object, ImageTexture>();
  constructor(private readonly renderer: WebGLRenderer) {}
  sync(batches: readonly StoryScreenSpriteBatch[]): void {
    const retained = new Set(batches);
    for (const [batch, view] of this.views)
      if (!retained.has(batch)) {
        this.scene.remove(view.mesh);
        view.mesh.geometry.dispose();
        view.mesh.material.dispose();
        this.views.delete(batch);
        const image = this.images.get(batch.image.source)!;
        if (--image.references === 0) {
          image.texture.dispose();
          this.images.delete(batch.image.source);
        }
      }
    batches.forEach((batch, index) => {
      let view = this.views.get(batch);
      if (!view) {
        let image = this.images.get(batch.image.source);
        if (!image) {
          const texture = new Texture(batch.image.source as TexImageSource);
          texture.colorSpace = NoColorSpace;
          texture.flipY = false;
          texture.premultiplyAlpha = true;
          texture.minFilter = LinearFilter;
          texture.magFilter = LinearFilter;
          texture.generateMipmaps = false;
          texture.needsUpdate = true;
          image = { texture, references: 0 };
          this.images.set(batch.image.source, image);
        }
        image.references++;
        const geometry = new InstancedBufferGeometry();
        geometry.setAttribute(
          "aCorner",
          new BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2),
        );
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        const buffer = new InstancedInterleavedBuffer(batch.instances, 10).setUsage(DynamicDrawUsage);
        geometry.setAttribute("aPosition", new InterleavedBufferAttribute(buffer, 2, 0));
        geometry.setAttribute("aRotation", new InterleavedBufferAttribute(buffer, 1, 2));
        geometry.setAttribute("aScale", new InterleavedBufferAttribute(buffer, 2, 3));
        geometry.setAttribute("aAlpha", new InterleavedBufferAttribute(buffer, 1, 5));
        geometry.setAttribute("aFrame", new InterleavedBufferAttribute(buffer, 4, 6));
        geometry.instanceCount = batch.instances.length / 10;
        const [a, b, c, d, x, y] = batch.transform;
        const sx = 2 / batch.referenceWidth,
          sy = -2 / batch.referenceHeight;
        const transform = new Matrix4().set(
            a * sx,
            c * sx,
            0,
            x * sx - 1,
            b * sy,
            d * sy,
            0,
            y * sy + 1,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
          ),
          projection = new Matrix4();
        const material = new RawShaderMaterial({
          vertexShader: vertex,
          fragmentShader: fragment,
          uniforms: {
            uTexture: { value: image.texture },
            uSize: { value: new Vector2(batch.width, batch.height) },
            uProjection: { value: projection },
            uTint: {
              value: new Vector3(
                ((batch.tint >> 16) & 255) / 255,
                ((batch.tint >> 8) & 255) / 255,
                (batch.tint & 255) / 255,
              ),
            },
          },
          transparent: true,
          depthTest: false,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
          blending: CustomBlending,
          blendEquation: AddEquation,
          blendSrc: OneFactor,
          blendDst: OneMinusSrcAlphaFactor,
          blendSrcAlpha: OneFactor,
          blendDstAlpha: OneMinusSrcAlphaFactor,
        });
        const mesh = new Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        view = { batch, mesh, buffer, revision: -1, texture: image.texture, transform, projection };
        this.views.set(batch, view);
        this.scene.add(mesh);
      }
      view.mesh.renderOrder = index;
      if (view.revision !== batch.revision) {
        view.buffer.needsUpdate = true;
        view.revision = batch.revision;
      }
    });
  }
  render(layer: "background" | "foreground", target: WebGLRenderTarget, stage: Matrix4): void {
    let count = 0;
    for (const view of this.views.values()) {
      view.mesh.visible = view.batch.layer === layer;
      if (view.mesh.visible) {
        count++;
        view.projection.multiplyMatrices(stage, view.transform);
      }
    }
    if (!count) return;
    const previous = this.renderer.getRenderTarget(),
      autoClear = this.renderer.autoClear;
    try {
      this.renderer.autoClear = false;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
      this.renderer.setRenderTarget(previous);
    }
  }
  dispose(): void {
    this.sync([]);
  }
}
