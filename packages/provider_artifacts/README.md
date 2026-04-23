# provider_artifacts

Shared artifact metadata helpers for browser/API workers.

Goals:

- Keep generated-image and downloaded-file metadata out of bot-specific code.
- Use one stable `artifact` record shape for providers, shims, and downstream consumers.
- Let workers keep their own binary outputs while sharing one index format.

Current first adopter:

- `providers/gpt-web-api`

## Image Organization Rule

Generated images should be organized and reviewed by `ArtifactRecord.model`, not
only by provider or by the raw filename.

Operational rules:

- Do not move existing binaries that are already referenced by `local_path`
  inside `media.json` / artifact records unless the migration also rewrites the
  persisted index.
- Treat `model` as the primary grouping key for image inventory, QA review, and
  future archive/export views.
- Keep provider-level ownership in metadata, but bucket image assets by model
  for human-facing organization.

Recommended model buckets:

- `chatgpt-images` / `gpt-image-2`
- `imagen-*` / `gemini-web` (runtime alias: `gemini-canvas`)
- `stable-diffusion`
- `flux`
- `seedream`
- `recraft`
- `midjourney`
- `other`

Current repository practice:

- Runtime binary paths stay where the worker wrote them.
- Human-facing inventory should be maintained in a model-grouped index such as
  [`ops/image-model-index.md`](../../ops/image-model-index.md).
- Regenerate the index with:
  `node packages/provider_artifacts/build_image_model_index.mjs`
