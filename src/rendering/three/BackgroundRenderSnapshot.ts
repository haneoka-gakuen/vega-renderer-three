/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
import { Material, Mesh, MeshBasicMaterial, Object3D, type Camera, type Scene, type Texture } from "three";

type BackgroundMesh = Mesh<import("three").BufferGeometry, MeshBasicMaterial>;

/** Camera-space inputs of the stage's two immutable-image background planes. */
export class BackgroundRenderSnapshot {
  private previous: unknown[] = new Array(256);
  private current: unknown[] = new Array(256);
  private count = 0;
  private cursor = 0;
  private revision = 0;
  private ready = false;
  private safe = false;
  private base: BackgroundMesh | null = null;
  private sprite: BackgroundMesh | null = null;
  private cameraMask = 0;

  private readonly visit = (object: Object3D): void => {
    const renderable = object as Object3D & {
      isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean;
      isSkinnedMesh?: boolean; isInstancedMesh?: boolean;
      isGroup?: boolean;
    };
    if (renderable.isGroup) { this.add(object); this.add(object.renderOrder); }
    if (!renderable.isMesh && !renderable.isLine && !renderable.isPoints && !renderable.isSprite) return;
    if (!(object.layers.mask & this.cameraMask)) return;
    const materials = (object as Mesh).material;
    if (Array.isArray(materials) ? materials.every((material) => !material.visible) : !materials.visible) return;
    if ((object !== this.base && object !== this.sprite) || renderable.isSkinnedMesh || renderable.isInstancedMesh) {
      this.safe = false;
      return;
    }
    const mesh = object as BackgroundMesh;
    const material = mesh.material;
    if (!material.isMeshBasicMaterial || material.envMap || material.alphaMap || material.aoMap || material.lightMap ||
      material.specularMap || material.vertexColors || material.stencilWrite || material.alphaHash || material.toneMapped || material.clippingPlanes?.length ||
      material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
      material.onBeforeRender !== Material.prototype.onBeforeRender ||
      mesh.onBeforeRender !== Object3D.prototype.onBeforeRender || mesh.onAfterRender !== Object3D.prototype.onAfterRender) {
      this.safe = false;
      return;
    }
    const geometry = mesh.geometry;
    if (geometry.morphAttributes.position?.length || geometry.morphAttributes.normal?.length || geometry.groups.length) {
      this.safe = false;
      return;
    }
    this.add(mesh); this.add(mesh.layers.mask); this.add(mesh.renderOrder); this.add(mesh.frustumCulled);
    this.matrix(mesh.matrixWorld.elements);
    this.add(geometry); this.add(geometry.drawRange.start); this.add(geometry.drawRange.count);
    this.attribute(geometry.getAttribute("position"));
    this.attribute(geometry.getAttribute("uv"));
    this.attribute(geometry.index);
    this.add(material); this.add(material.version); this.add(material.visible);
    this.add(material.color.r); this.add(material.color.g); this.add(material.color.b); this.add(material.opacity);
    this.add(material.side); this.add(material.transparent); this.add(material.alphaTest); this.add(material.alphaHash);
    this.add(material.alphaToCoverage); this.add(material.forceSinglePass);
    this.add(material.blending); this.add(material.blendSrc); this.add(material.blendDst); this.add(material.blendEquation);
    this.add(material.blendSrcAlpha); this.add(material.blendDstAlpha); this.add(material.blendEquationAlpha);
    this.add(material.blendColor.r); this.add(material.blendColor.g); this.add(material.blendColor.b); this.add(material.blendAlpha);
    this.add(material.premultipliedAlpha); this.add(material.colorWrite); this.add(material.depthTest); this.add(material.depthWrite);
    this.add(material.depthFunc); this.add(material.polygonOffset); this.add(material.polygonOffsetFactor); this.add(material.polygonOffsetUnits);
    this.add(material.wireframe); this.add(material.wireframeLinewidth); this.add(material.toneMapped); this.add(material.dithering);
    if (material.map) this.texture(material.map);
    else this.add(null);
  };

  capture(scene: Scene, camera: Camera, base: BackgroundMesh, sprite: BackgroundMesh | null): number | undefined {
    this.cursor = 0;
    this.safe = !scene.background && !scene.fog && !scene.overrideMaterial &&
      scene.onBeforeRender === Object3D.prototype.onBeforeRender && scene.onAfterRender === Object3D.prototype.onAfterRender;
    this.base = base;
    this.sprite = sprite;
    this.cameraMask = camera.layers.mask;
    if (this.safe) {
      this.add(camera.layers.mask);
      this.matrix(camera.matrixWorldInverse.elements);
      this.matrix(camera.projectionMatrix.elements);
      scene.traverseVisible(this.visit);
    }
    if (!this.safe || this.cursor > this.current.length) {
      this.clear();
      return undefined;
    }
    let same = this.ready && this.cursor === this.count;
    for (let index = 0; same && index < this.cursor; index++) same = Object.is(this.previous[index], this.current[index]);
    for (let index = this.cursor; index < this.count; index++) this.previous[index] = this.current[index] = undefined;
    const previous = this.previous;
    this.previous = this.current;
    this.current = previous;
    this.count = this.cursor;
    this.ready = true;
    if (same) return this.revision;
    this.revision++;
    return undefined;
  }

  clear(): void {
    this.previous.fill(undefined); this.current.fill(undefined);
    this.count = 0; this.ready = false;
    this.base = this.sprite = null;
  }

  private add(value: unknown): void {
    if (this.cursor < this.current.length) this.current[this.cursor] = value;
    this.cursor++;
  }

  private matrix(elements: ArrayLike<number>): void {
    for (let index = 0; index < elements.length; index++) this.add(elements[index]);
  }

  private attribute(attribute: import("three").BufferAttribute | import("three").InterleavedBufferAttribute | null): void {
    this.add(attribute);
    this.add(attribute && ("version" in attribute ? attribute.version : attribute.data.version));
  }

  private texture(texture: Texture): void {
    const image: unknown = texture.image;
    const immutable = (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) ||
      (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement);
    if (!immutable || texture.isRenderTargetTexture || texture.onUpdate || texture.channel !== 0) {
      this.safe = false;
      return;
    }
    this.add(texture); this.add(image); this.add(texture.version); this.add(texture.source.version);
    this.add(texture.colorSpace); this.add(texture.channel); this.add(texture.flipY); this.add(texture.premultiplyAlpha);
    this.add(texture.wrapS); this.add(texture.wrapT); this.add(texture.minFilter); this.add(texture.magFilter); this.add(texture.anisotropy);
    this.matrix(texture.matrix.elements);
  }
}
