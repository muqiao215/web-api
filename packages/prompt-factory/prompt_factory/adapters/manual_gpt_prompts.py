from __future__ import annotations

import hashlib
import json
from pathlib import Path

from prompt_factory.filters import build_prompt_record, unique_list
from prompt_factory.models import PromptRecord


def load_manual_gpt_prompts(path: Path) -> list[PromptRecord]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != "prompt-factory-manual-gpt-prompts.v1":
        raise ValueError(f"unsupported manual prompt schema in {path}")

    records: list[PromptRecord] = []
    file_revision = hashlib.sha256(path.read_bytes()).hexdigest()
    default_license = str(payload.get("upstream_license") or payload.get("license") or "")
    default_author = str(payload.get("upstream_author") or payload.get("author") or "")
    default_created_at = str(payload.get("upstream_created_at") or payload.get("created_at") or "")
    default_url = str(payload.get("upstream_url") or payload.get("url") or "")
    for index, item in enumerate(payload.get("prompts") or [], start=1):
        prompt = str(item.get("prompt", "")).strip()
        if not prompt:
            continue
        source_id = str(item.get("source_id") or f"manual-gpt-{index:04d}")
        records.append(
            build_prompt_record(
                source="manual-gpt-prompts",
                source_id=source_id,
                number=str(item.get("number") or index),
                title=str(item.get("title") or source_id),
                prompt=prompt,
                source_kind="direct",
                quality_tier=str(item.get("quality_tier") or "high"),
                platform_tags=unique_list(item.get("platform_tags") or ["gpt-image"]),
                model_tags=unique_list(item.get("model_tags") or ["gpt-image-2", "gpt-image"]),
                category_tags=unique_list(item.get("category_tags") or ["manual-curated"]),
                    metadata={
                        "adapter": "manual_gpt_prompts",
                        "source_file": str(path),
                    "notes": str(item.get("notes") or ""),
                        "original_author": str(item.get("original_author") or ""),
                        "meta_prompt": str(item.get("meta_prompt") or ""),
                    },
                    upstream_revision=str(item.get("upstream_revision") or payload.get("upstream_revision") or file_revision),
                    upstream_author=str(item.get("upstream_author") or item.get("original_author") or default_author),
                    upstream_license=str(item.get("upstream_license") or item.get("license") or default_license),
                    upstream_created_at=str(item.get("upstream_created_at") or item.get("created_at") or default_created_at),
                    upstream_url=str(item.get("upstream_url") or item.get("url") or default_url),
                )
            )

    return records
