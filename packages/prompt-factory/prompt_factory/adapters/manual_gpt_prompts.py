from __future__ import annotations

import json
from pathlib import Path

from prompt_factory.filters import build_prompt_record, unique_list
from prompt_factory.models import PromptRecord


def load_manual_gpt_prompts(path: Path) -> list[PromptRecord]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != "prompt-factory-manual-gpt-prompts.v1":
        raise ValueError(f"unsupported manual prompt schema in {path}")

    records: list[PromptRecord] = []
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
                },
            )
        )

    return records
