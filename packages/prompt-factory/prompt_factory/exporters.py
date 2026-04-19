from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now_epoch() -> float:
    return datetime.now(timezone.utc).timestamp()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def export_gpt_prompt_pool(pool: dict[str, Any], path: Path) -> None:
    prompts = []
    for item in pool["prompts"]:
        prompts.append(
            {
                "id": item["id"],
                "source": item["source"],
                "source_id": item["source_id"],
                "number": item["number"],
                "title": item["title"],
                "prompt": item["prompt"],
                "source_kind": item["source_kind"],
                "quality_tier": item["quality_tier"],
                "platform_tags": item["platform_tags"],
                "model_tags": item["model_tags"],
                "category_tags": item["category_tags"],
                "selection_score": item["selection_score"],
                "meta": {
                    **(item.get("metadata") or {}),
                    **(item.get("quality") or {}),
                    "canonical_id": item["canonical_id"],
                },
            }
        )
    _write_json(
        path,
        {
            "schema": "telegram-gpt-image-prompt-pool.v1",
            "version": 1,
            "fetched_at": _now_epoch(),
            "fetched_at_iso": _now_iso(),
            "source_counts": pool["source_counts"],
            "errors": pool.get("errors") or [],
            "prompt_count": len(prompts),
            "prompts": prompts,
        },
    )


def export_banana_prompts(pool: dict[str, Any], path: Path, *, max_prompts: int = 5000, min_chars: int = 180) -> None:
    prompts = []
    for item in pool["prompts"]:
        quality = item.get("quality") or {}
        if quality.get("human_related") or quality.get("requires_reference"):
            continue
        if len(str(item.get("prompt") or "")) < min_chars:
            continue
        prompts.append(
            {
                "id": item["id"],
                "source_id": item["source_id"],
                "number": item["source_id"] or item["number"],
                "title": item["title"],
                "prompt": item["prompt"],
            }
        )
        if len(prompts) >= max_prompts:
            break
    _write_json(
        path,
        {
            "version": 2,
            "source": "prompt_factory",
            "fetched_at": _now_epoch(),
            "total": len(prompts),
            "total_pages": 1,
            "start_page": 1,
            "pages_per_window": 1,
            "prompt_count": len(prompts),
            "prompts": prompts,
        },
    )


def export_used_index_seed(path: Path) -> None:
    _write_json(
        path,
        {
            "schema": "prompt-factory-used-index.v1",
            "generated_at_iso": _now_iso(),
            "used_prompt_ids": [],
        },
    )


def export_unified_pool(pool: dict[str, Any], path: Path) -> None:
    _write_json(path, pool)
