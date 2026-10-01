// Copies Excalidraw's bundled fonts into public/ so they're served locally
// (see window.EXCALIDRAW_ASSET_PATH in index.html). Runs before dev/build.
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts", import.meta.url));
const to = fileURLToPath(new URL("../public/fonts", import.meta.url));

await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log("Copied Excalidraw fonts to public/fonts");
