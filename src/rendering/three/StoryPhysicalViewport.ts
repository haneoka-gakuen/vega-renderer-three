/** Physical dimensions measured from the configured renderer, in drawing-buffer pixels. */
export interface StoryDrawingBufferExtent {
  readonly width: number;
  readonly height: number;
}

/** CSS placement stays separate from the renderer's physical authority. */
export interface StoryPhysicalViewport {
  readonly css: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly physical: StoryDrawingBufferExtent;
  readonly cssToPhysical: { readonly x: number; readonly y: number };
  readonly selectedPixelRatio: number;
  readonly effectivePixelRatio: number;
  readonly hardwareOverride: boolean;
}
