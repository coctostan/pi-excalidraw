# AGENTS.md

## Project
- `pi-excalidraw` is a pi extension for locally hosted Excalidraw.
- Prefer the existing local-server + HTTP-backed extension architecture unless a change clearly requires a different approach.

## External References
- Excalidraw API docs: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api
- Element skeleton API: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton
- Customizing styles: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/customizing-styles

## Guidance
- Consult the Excalidraw API docs before changing element creation, restore/load behavior, export flows, or scene-update semantics.
- Preserve IDs, bindings, and text/container relationships when working with saved/restored diagrams.
- Keep visual validation in the loop: generate or restore → focus canvas → capture screenshot → inspect result.
