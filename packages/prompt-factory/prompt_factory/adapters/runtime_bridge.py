from __future__ import annotations

import json
from pathlib import Path

from prompt_factory.filters import build_prompt_record, normalize_text
from prompt_factory.models import PromptRecord


def load_runtime_bridge_prompts(path: Path) -> list[PromptRecord]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("prompts") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []

    records: list[PromptRecord] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        prompt = normalize_text(item.get("prompt"))
        if not prompt:
            continue
        record = build_prompt_record(
            source=normalize_text(item.get("source")) or "runtime-bridge",
            source_id=normalize_text(item.get("source_id")) or normalize_text(item.get("id")) or str(index),
            number=normalize_text(item.get("number")) or str(index),
            title=normalize_text(item.get("title")) or prompt[:96],
            prompt=prompt,
            source_kind=normalize_text(item.get("source_kind")) or "direct",
            quality_tier=normalize_text(item.get("quality_tier")) or "medium",
            platform_tags=[str(value) for value in item.get("platform_tags") or []],
            model_tags=[str(value) for value in item.get("model_tags") or []],
            category_tags=[str(value) for value in item.get("category_tags") or []],
            metadata={
                "adapter": "runtime_bridge",
                "bridge_source_path": str(path),
                "legacy_id": normalize_text(item.get("id")),
                "legacy_meta": item.get("meta") if isinstance(item.get("meta"), dict) else {},
            },
        )
        records.append(record)
    return records
