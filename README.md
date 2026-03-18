# pi-excalidraw

`pi-excalidraw` is a reusable [pi](https://github.com/mariozechner/pi) package that gives pi a locally hosted Excalidraw canvas plus AI-callable drawing, layout, persistence, template, and screenshot workflows.

It is built for a practical local loop: pi can start the Excalidraw runtime, manipulate the canvas through tools, and use screenshots for visual feedback while you keep the same whiteboard open in a browser.

> [!IMPORTANT]
> `pi-excalidraw` is a local, browser-connected workflow. Canvas interaction, viewport control, and screenshot/export flows require a connected browser tab or pane. This package does **not** provide a hosted Excalidraw service or a fully headless drawing runtime.

![pi-excalidraw overview](assets/readme/pi-excalidraw-overview.png)

## What ships today

The package is intentionally focused on the workflows that are already implemented and validated:

- **Canvas launch + lifecycle** — start a local Excalidraw runtime and open a live canvas from pi
- **Low-level canvas manipulation** — create, inspect, update, delete, clear, and export Excalidraw elements
- **Visual feedback** — control viewport state and capture screenshots so the model can inspect what it drew
- **Higher-level diagram helpers** — generate labeled nodes, connected flows, and deterministic layouts with fewer low-level tool calls
- **Local persistence** — save and reload project-local diagrams under `.pi/excalidraw-diagrams/`
- **Reusable templates** — save and apply starter canvases under `.pi/excalidraw-templates/`

Not shipped yet:

- Mermaid conversion
- Hosted/cloud canvas workflows
- A separate collaboration backend beyond the local Excalidraw canvas flow

## Install

### Install from git

```bash
pi install git:github.com/coctostan/pi-excalidraw
```

### Install from a local checkout

```bash
pi install /absolute/path/to/pi-excalidraw
```

If you are actively working on this repository, clone it locally and install dependencies first:

```bash
git clone https://github.com/coctostan/pi-excalidraw.git
cd pi-excalidraw
npm install
```

## Quick start

After installation:

1. Start pi in the project where you want to use the canvas.
2. Run `/excalidraw` to start the local Excalidraw runtime.
3. Open the reported URL in a browser and keep the canvas connected.
4. Ask pi to draw or manipulate the canvas.

Example requests:

- “Open Excalidraw and sketch a simple system diagram.”
- “Create three connected nodes for API → worker → database, then lay them out horizontally.”
- “Save this as a reusable template called architecture-review.”
- “Capture a screenshot and tell me if the labels are readable.”

## How the package is structured

This repository now uses the repo root as the canonical pi package entrypoint:

- `src/index.ts` — canonical extension entrypoint declared in `package.json`
- `.pi/extensions/pi-excalidraw/index.ts` — thin project-local development shim so `/reload` still works while developing in this repo
- `vendor/mcp_excalidraw/` — vendored Excalidraw runtime assets required by the local server-backed workflow
- `scripts/smoke-test.mjs` — package smoke test that validates the root manifest and vendored runtime layout

## Validation

From the repository root:

```bash
npm install
npm run check
```

`npm run check` currently runs:

- `npm run typecheck`
- `npm run smoke-test`
- `npm pack --dry-run`

## Local development with `/reload`

If you are developing inside this repository, you usually do **not** need to reinstall the package after every edit.

Instead:

1. Open pi with this repository as your current project.
2. Edit `src/index.ts` or related files.
3. Run `/reload`.

Why that works:

- pi auto-discovers `.pi/extensions/pi-excalidraw/index.ts` in this repository
- that shim re-exports the canonical root implementation from `src/index.ts`
- `/reload` refreshes the extension, skills, prompts, and themes in the current project session

This keeps the root package layout correct for installs while preserving a fast local development loop.

## Runtime constraints and design notes

### Connected browser required

The canvas is not useful in isolation: the Excalidraw frontend must be open in a browser for the live canvas to exist. Screenshot, viewport, and export workflows depend on that connected client.

### Vendored runtime by design

The repository vendors the Excalidraw runtime under `vendor/mcp_excalidraw/` because the published upstream package did not ship the runnable frontend/runtime assets needed for this extension's local server workflow.

### Scope stays intentionally tight

`pi-excalidraw` is focused on reliable local diagramming workflows for pi. It does not currently try to be a hosted service, a generic docs site, or a Mermaid conversion layer.

## Common workflow examples

### Generate a simple flow diagram

Ask pi to:

- open Excalidraw
- create connected nodes
- apply layout
- focus the canvas
- capture a screenshot

That produces a tight generate → layout → inspect loop without manually editing every element.

### Save reusable starter canvases

Once you have a good base diagram, ask pi to save it as a template. Later you can apply that template into another project and customize it instead of rebuilding the same structure from scratch.

### Resume concrete diagrams

For project-specific artifacts, save the current scene as a diagram bundle. The package stores those bundles locally in the project so pi can reload and continue work later.

## Repository

- Public repo: `https://github.com/coctostan/pi-excalidraw`
- Homepage: `https://github.com/coctostan/pi-excalidraw#readme`

If you want to inspect the package before installing, read `src/index.ts`, `package.json`, and the vendored runtime layout under `vendor/mcp_excalidraw/`.
