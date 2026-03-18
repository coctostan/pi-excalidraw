import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function assertExists(relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  await access(absolutePath);
  console.log(`✓ Found ${relativePath}`);
}

async function assertDefaultExport(relativePath) {
  const moduleUrl = pathToFileURL(path.join(rootDir, relativePath)).href;
  const mod = await import(moduleUrl);
  if (typeof mod.default !== "function") {
    throw new Error(`${relativePath} does not export a default function`);
  }
  console.log(`✓ ${relativePath} exports a default function`);
}

async function assertPiManifest() {
  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const extensions = packageJson?.pi?.extensions;
  if (!Array.isArray(extensions) || extensions[0] !== "./src/index.ts") {
    throw new Error("package.json is missing the canonical pi.extensions entry for ./src/index.ts");
  }
  console.log("✓ package.json declares ./src/index.ts as the pi extension entrypoint");
}

await assertPiManifest();
await assertExists("vendor/mcp_excalidraw/package.json");
await assertExists("vendor/mcp_excalidraw/dist/server.js");
await assertExists("vendor/mcp_excalidraw/dist/frontend/index.html");
await assertDefaultExport("src/index.ts");
await assertDefaultExport(".pi/extensions/pi-excalidraw/index.ts");
