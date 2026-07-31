import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(root, "dist");

if (basename(output) !== "dist" || output === root) {
  throw new Error(`Refusing to clean unexpected build path: ${output}`);
}

await rm(output, { recursive: true, force: true });
