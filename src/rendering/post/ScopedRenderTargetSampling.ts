import type { ShaderMaterial, Texture, WebGLRenderer } from "three";

interface FilterState {
  readonly texture: WebGLTexture;
  readonly min: number;
  readonly mag: number;
  readonly wrapS: number;
  readonly wrapT: number;
}

/** URP LinearClamp is scoped to input targets; field blur keeps Point sampling. */
export class ScopedRenderTargetSampling {
  private originals = new WeakMap<Texture, FilterState>();
  private readonly reset = () => {
    this.originals = new WeakMap();
  };

  constructor(private readonly renderer: WebGLRenderer) {
    renderer.domElement.addEventListener("webglcontextrestored", this.reset);
  }

  render(material: ShaderMaterial, draw: () => void): void {
    const textures = new Set<Texture>();
    for (const uniform of Object.values(material.uniforms)) {
      const values = Array.isArray(uniform.value) ? uniform.value : [uniform.value];
      for (const value of values) {
        const texture = value as Texture | null;
        if (texture?.isTexture && texture.isRenderTargetTexture) textures.add(texture);
      }
    }
    if (textures.size === 0) {
      draw();
      return;
    }
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) {
      draw();
      return;
    }
    const binding = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const states: FilterState[] = [];
    for (const texture of textures) {
      const native = (this.renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
      if (!native) continue;
      gl.bindTexture(gl.TEXTURE_2D, native);
      let state = this.originals.get(texture);
      if (state?.texture !== native) {
        state = {
          texture: native,
          min: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER),
          mag: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER),
          wrapS: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S),
          wrapT: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T),
        };
        this.originals.set(texture, state);
      }
      if (
        state.min === gl.LINEAR &&
        state.mag === gl.LINEAR &&
        state.wrapS === gl.CLAMP_TO_EDGE &&
        state.wrapT === gl.CLAMP_TO_EDGE
      )
        continue;
      states.push(state);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, binding);
    try {
      draw();
    } finally {
      // Rendering may have selected another texture unit. Restore its binding
      // without changing Three's cached active unit or texture bindings.
      const after = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      for (const state of states) {
        gl.bindTexture(gl.TEXTURE_2D, state.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, state.min);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, state.mag);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, state.wrapS);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, state.wrapT);
      }
      gl.bindTexture(gl.TEXTURE_2D, after);
    }
  }

  dispose(): void {
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.reset);
    this.reset();
  }
}
