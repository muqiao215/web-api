# Ops

Operational definitions for the non-container runtime.

This repo uses systemd-first local deployment for now. Containers are not the default because browser-profile-bound services need real Chrome/CDP/noVNC/login-state operations.

Gemini operator naming follows a compatibility split:

- canonical provider surface: `providers/gemini-web/`
- current live transport: canvas-share bridge
- preserved compatibility/runtime path: `providers/canvas-to-api/`
- unchanged live service names: `canvas-to-api.service`, `gemini-canvas-browser@*.service`
- unchanged provider id compatibility: `gemini-canvas`

Treat that as an ops vocabulary rule, not a migration plan. Current runtime wiring stays on the canvas-share bridge until a later cutover is explicitly done.

Subdirectories:

- `systemd/`: unit templates.
- `env/`: non-secret env examples.
- `doctor/`: doctor command notes.
- `smoke/`: smoke-check recipes.
- `image-model-index.md`: non-destructive inventory of generated images grouped by image-generation model.

Regenerate image inventory:

- `node packages/provider_artifacts/build_image_model_index.mjs`
