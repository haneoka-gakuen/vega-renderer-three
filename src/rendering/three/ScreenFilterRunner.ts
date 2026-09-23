import {
  AddEquation,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  GLSL3,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  NearestFilter,
  NearestMipmapNearestFilter,
  NoBlending,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import type {
  StoryFilterContext,
  StoryFilterImage,
  StoryFilterPass,
  StoryFilterSurface,
  StoryScreenFilterController,
} from "@haneoka/vega/renderer-kit";
interface Surface extends StoryFilterSurface {
  target: WebGLRenderTarget;
}
interface Lease {
  target: WebGLRenderTarget;
  used: boolean;
  stamp: number;
}
export interface ScreenFilterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
const copyVertex = "varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}";
const copyFragment =
  "uniform sampler2D tInput;uniform vec4 uRect;varying vec2 vUv;void main(){gl_FragColor=texture2D(tInput,uRect.xy+vUv*uRect.zw);}";
function fragmentSource(source: string): string {
  const precision = /precision\s+(lowp|mediump|highp)\s+float\s*;/.exec(source)?.[1] ?? "mediump";
  return (
    `precision ${precision} float;\nout vec4 screenFilterOutput;\n` +
    source
      .replace(/^\s*#define SHADER_NAME[^\n]*$/gm, "")
      .replace(/precision\s+(?:lowp|mediump|highp)\s+float\s*;/g, "")
      .replace(/\bvarying\b/g, "in")
      .replace(/\bgl_FragColor\b/g, "screenFilterOutput")
      .replace(/\btexture2D\b/g, "texture")
  );
}
export class ScreenFilterRunner {
  private readonly pool: Lease[] = [];
  private stamp = 0;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new BufferGeometry();
  private readonly copyGeometry = new PlaneGeometry(2, 2);
  private readonly positions = new Float32Array(8);
  private readonly quad = new Mesh();
  private readonly materials = new Map<object, RawShaderMaterial>();
  private readonly images = new Map<object, { texture: Texture; revision: number; stamp: number }>();
  private readonly copy = new ShaderMaterial({
    vertexShader: copyVertex,
    fragmentShader: copyFragment,
    uniforms: {
      tInput: { value: null },
      uRect: { value: new Vector4(0, 0, 1, 1) },
    },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    toneMapped: false,
  });
  private readonly savedViewport = new Vector4();
  private readonly savedScissor = new Vector4();
  private readonly savedClear = new Color();
  constructor(private readonly renderer: WebGLRenderer) {
    this.geometry.setAttribute("aVertexPosition", new BufferAttribute(this.positions, 2));
    this.geometry.setAttribute("aTextureCoord", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-1, 1, 0, 1, 1, 0, 1, -1, 0, -1, -1, 0]), 3),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }
  private acquire(width: number, height: number): WebGLRenderTarget {
    let lease = this.pool.find((item) => !item.used && item.target.width === width && item.target.height === height);
    if (!lease) {
      const target = new WebGLRenderTarget(width, height, {
        format: RGBAFormat,
        type: UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: false,
      });
      target.texture.colorSpace = NoColorSpace;
      lease = { target, used: false, stamp: 0 };
      this.pool.push(lease);
    }
    lease.used = true;
    lease.stamp = this.stamp;
    return lease.target;
  }
  private release(target: WebGLRenderTarget) {
    const lease = this.pool.find((item) => item.target === target);
    if (lease) lease.used = false;
  }
  private uniform(value: unknown): unknown {
    if (value && typeof value === "object" && "target" in value) return (value as Surface).target.texture;
    if (value && typeof value === "object" && "source" in value && "revision" in value) {
      const image = value as StoryFilterImage;
      let entry = this.images.get(image.source);
      if (!entry) {
        const texture = new CanvasTexture(image.source as HTMLCanvasElement);
        texture.colorSpace = NoColorSpace;
        texture.magFilter = image.nearest ? NearestFilter : LinearFilter;
        texture.minFilter = image.mipmap
          ? image.nearest
            ? NearestMipmapNearestFilter
            : LinearMipmapLinearFilter
          : texture.magFilter;
        texture.generateMipmaps = image.mipmap ?? false;
        texture.flipY = false;
        entry = { texture, revision: -1, stamp: this.stamp };
        this.images.set(image.source, entry);
      }
      if (entry.revision !== image.revision) {
        entry.texture.needsUpdate = true;
        entry.revision = image.revision;
      }
      entry.stamp = this.stamp;
      return entry.texture;
    }
    return value;
  }
  private draw(pass: StoryFilterPass, input: Surface, output: Surface, context: StoryFilterContext) {
    let material = this.materials.get(pass.program);
    if (!material) {
      material = new RawShaderMaterial({
        vertexShader: pass.vertex
          .replace(/^\s*#define SHADER_NAME[^\n]*$/gm, "")
          .replace(/\battribute\b/g, "in")
          .replace(/\bvarying\b/g, "out")
          .replace(/\bprojectionMatrix\b/g, "uFilterProjection"),
        fragmentShader: fragmentSource(pass.fragment),
        glslVersion: GLSL3,
        uniforms: {},
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
        side: DoubleSide,
        transparent: true,
        blendEquation: AddEquation,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      });
      this.materials.set(pass.program, material);
    }
    material.blending = pass.blend ? CustomBlending : NoBlending;
    const final = output === context.output;
    const projectionWidth = final ? output.width : context.frameWidth;
    const projectionHeight = final ? output.height : context.frameHeight;
    const originX = final ? 0 : context.x;
    const originY = final ? 0 : context.y;
    const width = input.width,
      height = input.height,
      realWidth = input.target.width,
      realHeight = input.target.height;
    const values: Record<string, unknown> = {
      ...pass.uniforms,
      uSampler: input.target.texture,
      uFilterProjection: new Matrix3().set(
        2 / projectionWidth,
        0,
        -1 - (2 * originX) / projectionWidth,
        0,
        2 / projectionHeight,
        -1 - (2 * originY) / projectionHeight,
        0,
        0,
        1,
      ),
      filterArea: [width, height, context.x, context.y],
      filterClamp: [
        0.5 / realWidth,
        0.5 / realHeight,
        (context.frameWidth * context.resolution) / realWidth - 0.5 / realWidth,
        (context.frameHeight * context.resolution) / realHeight - 0.5 / realHeight,
      ],
      inputClamp: [
        0.5 / realWidth,
        0.5 / realHeight,
        (context.frameWidth * context.resolution) / realWidth - 0.5 / realWidth,
        (context.frameHeight * context.resolution) / realHeight - 0.5 / realHeight,
      ],
      inputSize: [width, height, 1 / width, 1 / height],
      inputPixel: [realWidth, realHeight, 1 / realWidth, 1 / realHeight],
      outputFrame: [context.x, context.y, context.frameWidth, context.frameHeight],
      resolution: context.resolution,
    };
    for (const [name, value] of Object.entries(values)) {
      const uniform = (material.uniforms[name] ??= { value: null });
      uniform.value = this.uniform(value);
    }
    material.uniformsNeedUpdate = true;
    (this.geometry.index!.array as Uint16Array).set(pass.legacy ? [0, 1, 2, 0, 2, 3] : [0, 1, 3, 3, 1, 2]);
    this.geometry.index!.needsUpdate = true;
    const w = pass.legacy ? context.frameWidth : 1,
      h = pass.legacy ? context.frameHeight : 1;
    const uv = this.geometry.attributes.aTextureCoord! as BufferAttribute;
    const u = context.frameWidth / input.width,
      v = context.frameHeight / input.height;
    (uv.array as Float32Array).set([0, 0, u, 0, u, v, 0, v]);
    uv.needsUpdate = true;
    const x = pass.legacy ? context.x : 0,
      y = pass.legacy ? context.y : 0;
    this.positions.set([x, y, x + w, y, x + w, y + h, x, y + h]);
    this.geometry.attributes.aVertexPosition!.needsUpdate = true;
    this.quad.geometry = this.geometry;
    this.quad.material = material;
    const previousViewport = output.target.viewport.clone();
    if (!final)
      output.target.viewport.set(
        0,
        0,
        context.frameWidth * context.resolution,
        context.frameHeight * context.resolution,
      );
    try {
      this.renderer.setRenderTarget(output.target);
      this.renderer.setScissorTest(false);
      this.renderer.clear(true, false, false);
      this.renderer.render(this.scene, this.camera);
    } finally {
      output.target.viewport.copy(previousViewport);
    }
  }
  private blit(texture: Texture, target: WebGLRenderTarget, uv: readonly number[], viewport?: ScreenFilterBounds) {
    this.copy.uniforms.tInput!.value = texture;
    (this.copy.uniforms.uRect!.value as Vector4).set(uv[0]!, uv[1]!, uv[2]!, uv[3]!);
    this.quad.geometry = this.copyGeometry;
    this.quad.material = this.copy;
    const previousViewport = target.viewport.clone();
    if (viewport) target.viewport.set(viewport.x, viewport.y, viewport.width, viewport.height);
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.setScissorTest(false);
      this.renderer.render(this.scene, this.camera);
    } finally {
      target.viewport.copy(previousViewport);
    }
  }
  render(
    controller: StoryScreenFilterController,
    target: WebGLRenderTarget,
    resolution = 1,
    bounds?: ScreenFilterBounds,
  ): void {
    if (!controller.active) return;
    this.stamp++;
    const padding = Math.ceil(controller.padding * resolution);
    const left = Math.max(0, Math.floor((bounds?.x ?? 0) - padding)),
      bottom = Math.max(0, Math.floor((bounds?.y ?? 0) - padding));
    const right = Math.min(target.width, Math.ceil((bounds ? bounds.x + bounds.width : target.width) + padding)),
      top = Math.min(target.height, Math.ceil((bounds ? bounds.y + bounds.height : target.height) + padding));
    if (right <= left || top <= bottom) return;
    const width = right - left,
      height = top - bottom,
      allocatedWidth = width === target.width && height === target.height ? width : 2 ** Math.ceil(Math.log2(width)),
      allocatedHeight = width === target.width && height === target.height ? height : 2 ** Math.ceil(Math.log2(height)),
      leases: WebGLRenderTarget[] = [];
    const previous = this.renderer.getRenderTarget(),
      autoClear = this.renderer.autoClear,
      scissor = this.renderer.getScissorTest(),
      clearAlpha = this.renderer.getClearAlpha();
    this.renderer.getViewport(this.savedViewport);
    this.renderer.getScissor(this.savedScissor);
    this.renderer.getClearColor(this.savedClear);
    const acquire = (): Surface => {
      const texture = this.acquire(allocatedWidth, allocatedHeight);
      leases.push(texture);
      return {
        target: texture,
        width: allocatedWidth / resolution,
        height: allocatedHeight / resolution,
      };
    };
    try {
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0, 0);
      const input = acquire();
      const output: Surface = {
        target: this.acquire(target.width, target.height),
        width: target.width / resolution,
        height: target.height / resolution,
      };
      leases.push(output.target);
      this.renderer.setRenderTarget(input.target);
      this.renderer.setScissorTest(false);
      this.renderer.clear(true, false, false);
      this.blit(
        target.texture,
        input.target,
        [left / target.width, top / target.height, width / target.width, -height / target.height],
        { x: 0, y: 0, width, height },
      );
      const context: StoryFilterContext = {
        input,
        output,
        resolution,
        x: left / resolution,
        y: (target.height - top) / resolution,
        frameWidth: width / resolution,
        frameHeight: height / resolution,
        acquire,
        release: (surface) => this.release((surface as Surface).target),
        draw: (pass, input, output) => this.draw(pass, input as Surface, output as Surface, context),
      };
      controller.render(context);
      this.blit(
        output.target.texture,
        target,
        [left / target.width, (target.height - bottom) / target.height, width / target.width, -height / target.height],
        { x: left, y: bottom, width, height },
      );
    } finally {
      for (const lease of leases) this.release(lease);
      this.renderer.setRenderTarget(previous);
      this.renderer.setViewport(this.savedViewport);
      this.renderer.setScissor(this.savedScissor);
      this.renderer.setScissorTest(scissor);
      this.renderer.setClearColor(this.savedClear, clearAlpha);
      this.renderer.autoClear = autoClear;
      for (const [key, image] of this.images)
        if (this.stamp - image.stamp > 120) {
          image.texture.dispose();
          this.images.delete(key);
        }
      let bytes = this.pool.reduce((sum, item) => sum + item.target.width * item.target.height * 4, 0);
      for (const item of [...this.pool].sort((a, b) => a.stamp - b.stamp))
        if (!item.used && this.stamp - item.stamp > 30 && (bytes > 64 * 1024 * 1024 || this.stamp - item.stamp > 240)) {
          bytes -= item.target.width * item.target.height * 4;
          item.target.dispose();
          this.pool.splice(this.pool.indexOf(item), 1);
        }
    }
  }
  dispose() {
    for (const lease of this.pool) lease.target.dispose();
    this.pool.length = 0;
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    for (const entry of this.images.values()) entry.texture.dispose();
    this.images.clear();
    this.copy.dispose();
    this.copyGeometry.dispose();
    this.geometry.dispose();
    this.scene.remove(this.quad);
  }
}
