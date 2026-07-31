# `@haneoka/vega-renderer-three`

Three.js WebGL2 renderer for Vega.

- Command-complete scene backend for Vega ADV playback
- Background, character, still, frame, video, particle, transition and camera layers
- Optional ADV-style bloom, LDR/HDR color grading, depth of field, motion blur and FXAA
- Abort-aware resource ownership, deterministic seek snapshots and WebGL context recovery
- Renderer-aware character providers for Cubism, Spine and third-party runtimes

```sh
pnpm add @haneoka/vega @haneoka/vega-renderer-three three howler
```

```ts
import { VegaEngine } from "@haneoka/vega";
import { createThreeRendererPlugin } from "@haneoka/vega-renderer-three";

const engine = new VegaEngine({
  plugins: [createThreeRendererPlugin()],
});
```

Install separate character plugins for Cubism, Spine, or other dynamic formats.

## Renderer profiles

The default `vega` profile is portable. The optional `unity-adv` profile adds
compatible field semantics. Color grading supports `ldr` and `hdr`. Optional
material textures can be supplied through `postTextureAssets`:

```ts
createThreeRendererPlugin({
  postTextureAssets: {
    "haneoka.renderer-three/film-grain/0":
      "/authorized-assets/film-grain/thin-1.png",
  },
});
```

## License

MPL-2.0. Three.js and Howler are separately installed peer dependencies and
are not bundled in the published package.
