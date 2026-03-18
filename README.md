# pi-excalidraw

`pi-excalidraw` is a reusable pi package for a locally hosted Excalidraw canvas with AI-callable drawing, layout, persistence, template, and screenshot workflows.

Canonical public repository: `https://github.com/coctostan/pi-excalidraw`.

## Phase 7 package foundation

This repository now treats the repo root as the canonical pi package entrypoint:

- `src/index.ts` is the canonical extension entry
- `vendor/mcp_excalidraw/` contains the vendored canvas runtime assets required by the extension
- `.pi/extensions/pi-excalidraw/index.ts` is a thin project-local development shim so `/reload` still works during local development

## Local validation

```bash
npm install
npm run check
```

## Install with pi

From a local path:

```bash
pi install /absolute/path/to/pi-excalidraw
```

From git:
```bash
pi install git:github.com/coctostan/pi-excalidraw
```

## Notes

- The extension keeps the existing local-server + HTTP-backed architecture.
- The vendored runtime is kept in this repository because the published `mcp-excalidraw-server` package does not include the runnable canvas/frontend build needed for this workflow.
- More complete installation docs, public repo setup, and polished README assets are planned for later phases.
