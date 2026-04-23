# Ops

Operational definitions for the non-container runtime.

This repo uses systemd-first local deployment for now. Containers are not the default because browser-profile-bound services need real Chrome/CDP/noVNC/login-state operations.

Subdirectories:

- `systemd/`: unit templates.
- `env/`: non-secret env examples.
- `doctor/`: doctor command notes.
- `smoke/`: smoke-check recipes.
- `image-model-index.md`: non-destructive inventory of generated images grouped by image-generation model.

Regenerate image inventory:

- `node packages/provider_artifacts/build_image_model_index.mjs`
