# `@haneoka/vega-renderer-three`

`@haneoka/vega-renderer-three` is the Three.js WebGL2 scene backend for Vega.
It renders the ADV command surface through real Three.js transforms and owns
the scene camera, stage layers, characters, effects, transitions, videos,
resource leases, and WebGL teardown.

## Features

- Background, character, still, frame, video, particle, transition, camera,
  HUD, and screen-filter layers.
- `vega` and `unity-adv` renderer profiles, LDR and HDR color-grading paths,
  bloom, depth of field, motion blur, Panini projection, and FXAA.
- Renderer-aware character providers for Cubism, Spine, and application-owned
  runtimes.
- Abort-aware resource preparation, deterministic seek snapshots, bounded
  texture ownership, and WebGL context-loss recovery.

The plugin is the normal integration surface. `ThreeStoryScene` is exported for
hosts that construct a `StorySceneBackend` directly; its constructor requires a
complete `StorySceneBackendContext` and an optional `ThreeStorySceneOptions`.

## Build from source

The package currently consumes the unpublished Vega peer from a Git workspace.
Clone the two repositories side by side in one pnpm workspace:

```sh
mkdir vega-three-workspace
cd vega-three-workspace
git clone https://github.com/haneoka-gakuen/vega.git packages/vega
git clone https://github.com/haneoka-gakuen/vega-renderer-three.git packages/vega-renderer-three
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/vega
  - packages/vega/packages/*
  - packages/vega-renderer-three
linkWorkspacePackages: true
```

Then install and build the local packages:

```sh
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install
pnpm --filter @haneoka/vega build:core
pnpm --filter @haneoka/vega-renderer-three check
```

The renderer requires Node 20 or newer, Three.js `0.184.x`, and a browser or
WebView with WebGL2.

## Smallest complete player

The Vega engine creates the renderer from `createThreeRendererPlugin()` and
passes it the mounted story context. This is the smallest runnable browser
player with a Three scene:

```ts
import { VegaEngine } from "@haneoka/vega/engine";
import { VEGA_ADV_OPCODE } from "@haneoka/vega-protocol/opcodes";
import { createThreeRendererPlugin } from "@haneoka/vega-renderer-three";

const mount = document.querySelector<HTMLElement>("#player");
if (!mount) throw new Error("Add <div id=\"player\"></div> to the page");

const engine = new VegaEngine({
  plugins: [createThreeRendererPlugin({ profile: "vega" })]
});
const handle = await engine.createPlayer({
  mount,
  story: {
    commands: [
      {
        command: VEGA_ADV_OPCODE.Talk,
        targetName: "Guide",
        text: "The Three.js stage is running.",
        noWait: true
      }
    ]
  }
});

await handle.player.play();
console.log(handle.player.state.finished, handle.player.SceneRoot.backend);

await handle.dispose();
await engine.dispose();
```

`createPlayer()` supplies `mount`, the merged ADV runtime, player state, a
`DefaultStoryResourceResolver`, character providers, active renderer effects,
and an abort signal. The renderer creates its canvas during `setup(mount)` and
consumes the `AdvPlayer` frame loop. The application supplies story URLs and
the host serves those files; the renderer does not invent asset paths.

## Profiles and post textures

The portable profile is the default. Select the compatibility profile when the
story was authored for Unity ADV field semantics:

```ts
const renderer = createThreeRendererPlugin({
  profile: "unity-adv",
  colorGradingMode: "hdr",
  postTextureAssets: {
    "haneoka.renderer-three/film-grain/0":
      "/authorized-assets/post/film-grain-0.png"
  }
});
```

`postTextureAssets` maps a renderer resource key to a host URL. The plugin loads,
caches, and releases the textures through its engine lifetime. Supply a custom
`postTextureResolver` when the application already owns an archive, CDN, or
desktop-resource loader; choose one mechanism, because the options reject both
at once.

Install a character provider alongside the renderer when a story contains a
dynamic model. The renderer selects the provider for its `rendererId`, supplies
the shared `ThreeRendererContext`, and disposes renderer-owned models when a
character leaves the scene or the player ends.

## Resource, host, and lifetime contract

Vega remains the host-facing interpreter. This package renders the scene and
does not supply story conversion, audio clocks, input mapping, save storage, or
licensed character SDKs. A host typically combines:

1. `@haneoka/vega` for command execution and state.
2. This package for WebGL2 presentation.
3. A UI/theme plugin for dialogue and controls.
4. Audio, input, resource, and character plugins for the host environment.

Dispose the returned player handle when replacing a story. Dispose the engine
when the host shuts down. Those calls abort in-flight loads, release resource
leases, destroy the scene, dispose Three textures and render targets, remove
the canvas listeners, and release the WebGL renderer. Call `handle.player.resize()`
after a host-controlled layout change when the stage size changes outside its
normal observer path.

## License

The package is available under [MPL-2.0](LICENSE); scope and notices are in
[LICENSE-SCOPE.md](LICENSE-SCOPE.md), [NOTICE.md](NOTICE.md), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Three.js and Howler remain
peer dependencies with their own licenses. Game and character assets retain
their source licenses.
