# Artifact Schema Mapping

This document maps fields between `image-task.schema.json` outputs and `artifact-record.schema.json`.

## Relationship

- `image-task.outputs[]` items are **immediate lightweight results** returned directly from a provider worker.
- `artifact-record` is the **persisted artifact index record** shared across workers, bots, showcase sites, and admin surfaces.
- The two schemas represent different lifecycle stages and are not interchangeable — they require an explicit conversion step.

## Schema Files

| Schema | File | Purpose |
|--------|------|---------|
| `ImageTask` | `image-task.schema.json` | Async task state machine with output items |
| `ArtifactOutput` | `artifact-output.schema.json` | Lightweight output item; referenced by ImageTask.outputs[] |
| `ArtifactRecord` | `artifact-record.schema.json` | Persisted artifact index record |

## Field Mapping: ImageTask.outputs[] → ArtifactRecord

| ImageTask.outputs field | ArtifactRecord field | Notes |
|------------------------|---------------------|-------|
| `artifact_id` | `id` | Rename snake_case → id |
| `url` | `url` | Pass through |
| `mime` | `mime_type` | Rename |
| `width` | `metadata.width` | Move into metadata |
| `height` | `metadata.height` | Move into metadata |
| `sha256` | `metadata.sha256` | Move into metadata |
| _(task-level)_ | `object` | Set to `"artifact"` |
| _(task-level)_ | `provider` | Copy from ImageTask.provider |
| _(task-level)_ | `model` | Copy from ImageTask.model |
| _(task-level)_ | `kind` | Set to `"image"` for image tasks |
| _(task-level)_ | `created_at` | Unix timestamp (integer seconds) — copy from ImageTask.completed_at (ISO string) or use current time |
| _(task-level)_ | `local_path` | Set by worker: path where artifact file is stored on disk |
| _(task-level)_ | `metadata.job_id` | Copy from ImageTask.id |
| _(task-level)_ | `metadata.provider_profile_id` | Copy from ImageTask.account_id |
| _(task-level)_ | `metadata.provider_profile_label` | Copy from ImageTask.profile_lock |
| _(task-level)_ | `metadata.conversation_id` | Copy from ImageTask.parent_task_id or metadata.conversation_id |
| _(task-level)_ | `metadata.conversation_url` | Set by worker if available |
| _(task-level)_ | `source_url` | Set to upstream source URL if applicable |
| _(task-level)_ | `prompt` | Copy from ImageTask.prompt |
| _(task-level)_ | `metadata` | Merge any existing ImageTask.metadata; add width/height/sha256 |

## Conversion Pseudocode

```js
function imageTaskOutputToArtifactRecord(output, task, localPath) {
  return {
    contract_version: "wcapi.artifact.v1",
    id: output.artifact_id,
    object: "artifact",
    provider: task.provider,
    kind: "image",
    model: task.model,
    prompt: task.prompt,
    mime_type: output.mime || "",
    created_at: Math.floor(new Date(task.completed_at || Date.now()).getTime() / 1000),
    local_path: localPath,
    url: output.url,
    metadata: {
      ...(task.metadata || {}),
      width: output.width,
      height: output.height,
      sha256: output.sha256,
      job_id: task.id,
      provider_profile_id: task.account_id,
      provider_profile_label: task.profile_lock,
    },
  };
}
```

## Design Notes

- `artifact_id` in `ImageTask.outputs[]` is the local identifier assigned by the provider at generation time. It becomes `id` in `ArtifactRecord`.
- `width`/`height` are placed in `metadata` rather than at the top level of `ArtifactRecord` to keep the top-level shape stable while allowing per-output dimensions.
- `sha256` is similarly placed in `metadata` since `ArtifactRecord` does not have a top-level digest field.
- `local_path` is always task-level because artifact files are stored on the worker disk, not embedded in the task output.
- `contract_version` is separate from the `ArtifactOutput` schema version — `ArtifactRecord` uses `wcapi.artifact.v1` as its own version string.
