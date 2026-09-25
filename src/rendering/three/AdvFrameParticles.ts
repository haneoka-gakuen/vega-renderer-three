import { Group, Object3D, Vector3 } from "three";
import {
  resolveStoryFrameLayout,
  type AdvFrameEntry,
  type StoryFrameLayout,
} from "@haneoka/vega/renderer-kit";
import { UnityParticleSystemView } from "../particles/UnityParticleEffect";
import type { UnityEffectRuntimeDefinition } from "../particles/UnityParticleTypes";

interface FrameParticleSlot {
  readonly view: UnityParticleSystemView;
  readonly layoutNode: string;
  placementOpacity: number;
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringId = (value: unknown): string => (typeof value === "string" ? value : "");

/** Same FNV-1a identity the opcode-54 effect controller seeds simulations with. */
function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 0x9e3779b9;
}

/**
 * Authored frame prefabs gate whole particle subtrees behind RectTransforms
 * whose serialized localScale is exactly zero (e.g. kirakira's EfKirakiraAll)
 * while their AnimatorController clips ship empty, so the serialized state is
 * the invisible one. Keep those subtrees at unit scale for placement.
 */
const clampZeroScaledNodes = (layout: StoryFrameLayout): StoryFrameLayout => {
  let changed = false;
  const nodes = layout.nodes.map((node) => {
    if (node.scale[0] === 0 && node.scale[1] === 0) {
      changed = true;
      return { ...node, scale: [1, 1] as const };
    }
    return node;
  });
  return changed ? { ...layout, nodes } : layout;
};

/**
 * Serialized ParticleSystems of one ADV frame prefab, replayed on the canvas
 * overlay through the shared Unity particle runtime.
 *
 * Each system keeps its authored simulation (modules, curves, materials) from
 * the opcode-54 effect contract; placement flattens the emitter's RectTransform
 * chain — resolved through the frame layout, the same anchoring math the
 * static images use — into one NDC-space node for the pass's orthographic
 * camera. Simulation advances on the frame elapsed clock and the emitted
 * alpha is scaled by the frame opacity.
 */
export class AdvFrameParticles {
  readonly group = new Group();
  private readonly slots: FrameParticleSlot[] = [];
  private readonly baseLayout: StoryFrameLayout;
  private frameOpacity = 1;

  private constructor(layout: StoryFrameLayout) {
    this.baseLayout = layout;
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
  }

  static async create(
    frame: AdvFrameEntry,
    layout: StoryFrameLayout,
    key: string,
  ): Promise<AdvFrameParticles> {
    const runtime = frame.particleRuntime as Partial<UnityEffectRuntimeDefinition> | undefined;
    if (
      !runtime ||
      !Array.isArray(runtime.nodes) ||
      !Array.isArray(runtime.particleSystems) ||
      !Array.isArray(runtime.particleRenderers) ||
      !Array.isArray(runtime.meshes)
    ) {
      throw new TypeError(`ADV frame particle runtime is invalid: ${key}`);
    }
    const meshes = new Map(runtime.meshes.map((mesh) => [mesh.id, mesh]));
    const systems = new Map(runtime.particleSystems.map((system) => [system.id, system]));
    const renderers = new Map(runtime.particleRenderers.map((renderer) => [renderer.id, renderer]));
    const descriptors = Array.isArray(frame.particles) ? frame.particles : [];
    const seed = hashSeed(`${key}:${stringId(runtime.source)}`);
    const result = new AdvFrameParticles(layout);
    let index = 0;
    for (const descriptor of descriptors) {
      const system = systems.get(stringId(descriptor.system));
      const renderer = renderers.get(stringId(descriptor.renderer));
      if (!system || !renderer || !renderer.enabled || renderer.renderMode === 5) continue;
      const node = new Object3D();
      node.matrixAutoUpdate = false;
      result.group.add(node);
      const view = await UnityParticleSystemView.create(
        system,
        renderer,
        node,
        meshes,
        seed + index * 977,
      );
      index += 1;
      // The canvas pass draws into the default framebuffer without a depth
      // clear; particle quads must never depth-test against earlier passes.
      view.mesh.material.depthTest = false;
      view.mesh.material.depthWrite = false;
      view.mesh.renderOrder = renderer.sortingOrder;
      view.externalParticleScale = new Vector3();
      view.frameOpacity = 0;
      result.slots.push({
        view,
        layoutNode: stringId(descriptor.layoutNode),
        placementOpacity: 0,
      });
    }
    return result;
  }

  get systemCount(): number {
    return this.slots.length;
  }

  play(): void {
    for (const slot of this.slots) slot.view.play(1);
  }

  setOpacity(value: number): void {
    this.frameOpacity = Math.max(0, Math.min(1, finite(value)));
    this.group.visible = this.frameOpacity > 0;
    for (const slot of this.slots) slot.view.frameOpacity = this.frameOpacity * slot.placementOpacity;
  }

  /**
   * Recompute emitter placements. `layout` may be the animator-sampled frame
   * layout; falls back to the authored one before the first sample.
   */
  layout(layout: StoryFrameLayout | undefined, width: number, height: number): void {
    const source = clampZeroScaledNodes(layout ?? this.baseLayout);
    const placements = new Map(
      resolveStoryFrameLayout(source, width, height).map((placement) => [placement.node.id, placement]),
    );
    // Reference-canvas pixel size in NDC, matching the layout resolver's
    // uniform device scale (used to revive zero-scaled emitter subtrees).
    const referenceScale = width / Math.max(1, source.referenceWidth);
    const referenceUnitX = (2 * referenceScale) / Math.max(1, width);
    const referenceUnitY = (2 * referenceScale) / Math.max(1, height);
    const unitZ = Math.min(referenceUnitX, referenceUnitY) * 0.001;
    for (const slot of this.slots) {
      const placement = slot.layoutNode ? placements.get(slot.layoutNode) : undefined;
      const node = slot.view.node;
      if (!placement) {
        node.visible = false;
        slot.placementOpacity = 0;
        slot.view.frameOpacity = 0;
        continue;
      }
      node.visible = true;
      slot.placementOpacity = placement.opacity;
      slot.view.frameOpacity = this.frameOpacity * placement.opacity;
      // placement.transform maps emitter-local reference pixels (y-down, like
      // the image quads' uv frame) to device pixels (y-down); the authored
      // particle simulation space is y-up, so the local y basis is negated
      // once while composing the device→NDC mapping (which flips y again).
      const [a, b, c, d, x, y] = placement.transform;
      const kx = 2 / Math.max(1, width);
      const ky = 2 / Math.max(1, height);
      const scaleX = Math.hypot(a * kx, b * ky);
      const scaleY = Math.hypot(c * kx, d * ky);
      if (scaleX > 1e-6 && scaleY > 1e-6) {
        node.matrix.set(
          a * kx, -c * kx, 0, x * kx - 1,
          -b * ky, d * ky, 0, 1 - y * ky,
          0, 0, unitZ, -0.5,
          0, 0, 0, 1,
        );
        slot.view.externalParticleScale?.set(scaleX, scaleY, unitZ);
      } else {
        // A collapsed chain (exact zero authored scale) keeps the composed
        // translation and draws at one unit per reference pixel.
        node.matrix.set(
          referenceUnitX, 0, 0, x * kx - 1,
          0, referenceUnitY, 0, 1 - y * ky,
          0, 0, unitZ, -0.5,
          0, 0, 0, 1,
        );
        slot.view.externalParticleScale?.set(referenceUnitX, referenceUnitY, unitZ);
      }
      node.matrixWorldNeedsUpdate = true;
    }
    this.group.updateMatrixWorld(true);
  }

  update(deltaSeconds: number): void {
    if (!this.group.visible) return;
    for (const slot of this.slots) slot.view.update(Math.max(0, deltaSeconds));
  }

  setRenderOrder(order: number): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      this.slots[index].view.mesh.renderOrder = order + index * 0.00001;
    }
  }

  hasVisibleContent(): boolean {
    if (!this.group.visible) return false;
    for (const slot of this.slots) {
      if (
        slot.view.node.visible &&
        slot.view.mesh.visible &&
        slot.view.mesh.geometry.instanceCount > 0
      ) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    for (const slot of this.slots) slot.view.dispose();
    this.slots.length = 0;
    this.group.clear();
  }
}
