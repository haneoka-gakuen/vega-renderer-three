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
  private readonly textures = new Set<Texture>();
  private readonly states: FilterState[] = [];
  private readonly reset = () => {
    this.originals = new WeakMap();
  };

  constructor(private readonly renderer: WebGLRenderer) {
    renderer.domElement.addEventListener("webglcontextrestored", this.reset);
  }

  render(material: ShaderMaterial, draw: () => void): void {
    const textures = this.textures;
    textures.clear();
    for (const name in material.uniforms) {
      const value = material.uniforms[name]!.value;
      if (Array.isArray(value)) {
        for (const texture of value) if (texture?.isTexture && texture.isRenderTargetTexture) textures.add(texture);
      } else if (value?.isTexture && value.isRenderTargetTexture) textures.add(value);
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
    const states = this.states;
    states.length = 0;
    for (const texture of textures) {
      const native = (this.renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
      if (!native) continue;
      let state = this.originals.get(texture);
      if (state?.texture !== native) {
        this.bind(native);
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
      this.bind(native);
      if (state.min !== gl.LINEAR) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      if (state.mag !== gl.LINEAR) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (state.wrapS !== gl.CLAMP_TO_EDGE) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      if (state.wrapT !== gl.CLAMP_TO_EDGE) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    try {
      draw();
    } finally {
      for (const state of states) {
        this.bind(state.texture);
        if (state.min !== gl.LINEAR) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, state.min);
        if (state.mag !== gl.LINEAR) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, state.mag);
        if (state.wrapS !== gl.CLAMP_TO_EDGE) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, state.wrapS);
        if (state.wrapT !== gl.CLAMP_TO_EDGE) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, state.wrapT);
      }
      states.length = 0;
      textures.clear();
    }
  }

  // Bind through Three's cache; the following draw owns its texture units.
  private bind(texture: WebGLTexture): void {
    const gl = this.renderer.getContext();
    this.renderer.state.activeTexture(gl.TEXTURE0);
    this.renderer.state.bindTexture(gl.TEXTURE_2D, texture);
  }

  dispose(): void {
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.reset);
    this.reset();
    this.textures.clear();
    this.states.length = 0;
  }
}
