from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from prompt_factory.adapters import (
    compose_toloka_prompts,
    load_prompt_pack_prompts,
    load_runtime_bridge_prompts,
    load_stable_diffusion_templates,
    load_toloka_prompts,
    load_youmind_skill_prompts,
)
from prompt_factory.filters import record_allowed
from prompt_factory.models import PromptPolicy, PromptRecord

SOURCE_KIND_RANK = {"direct": 3, "atomic": 2, "composed": 1}
QUALITY_TIER_RANK = {"high": 3, "medium": 2, "experimental": 1}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def _rank(record: PromptRecord) -> tuple[int, int, int, int]:
    return (
        SOURCE_KIND_RANK.get(record.source_kind, 0),
        QUALITY_TIER_RANK.get(record.quality_tier, 0),
        int(record.selection_score),
        len(record.prompt),
    )


def _dedupe(records: list[PromptRecord]) -> list[PromptRecord]:
    chosen: dict[str, PromptRecord] = {}
    for record in records:
        current = chosen.get(record.canonical_id)
        if current is None or _rank(record) > _rank(current):
            chosen[record.canonical_id] = record
    out = sorted(chosen.values(), key=_rank, reverse=True)
    return out


def build_prompt_pool(
    source_paths: dict[str, Path],
    *,
    include_sources: list[str] | None = None,
    compose_keyword_limit: int = 55,
    policy: PromptPolicy | None = None,
) -> dict[str, Any]:
    policy = policy or PromptPolicy()
    include = include_sources or ["youmind", "toloka", "stable_diffusion", "atomic_composer"]
    records: list[PromptRecord] = []
    errors: list[str] = []
    source_meta: list[dict[str, str]] = []
    toloka_rows: list[dict[str, str]] = []
    toloka_keywords: list[str] = []

    if "youmind" in include and source_paths.get("youmind"):
        path = source_paths["youmind"]
        try:
            batch = load_youmind_skill_prompts(path)
            records.extend(batch)
            source_meta.append({"name": "youmind", "path": str(path), "count": str(len(batch))})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"youmind: {exc}")

    if "toloka" in include and source_paths.get("toloka"):
        path = source_paths["toloka"]
        try:
            batch, toloka_rows, toloka_keywords = load_toloka_prompts(path)
            records.extend(batch)
            source_meta.append({"name": "toloka", "path": str(path), "count": str(len(batch))})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"toloka: {exc}")

    if "stable_diffusion" in include and source_paths.get("stable_diffusion"):
        path = source_paths["stable_diffusion"]
        try:
            batch = load_stable_diffusion_templates(path)
            records.extend(batch)
            source_meta.append({"name": "stable_diffusion", "path": str(path), "count": str(len(batch))})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"stable_diffusion: {exc}")

    if "prompt_pack" in include and source_paths.get("prompt_pack"):
        path = source_paths["prompt_pack"]
        try:
            batch = load_prompt_pack_prompts(path)
            records.extend(batch)
            source_meta.append({"name": "prompt_pack", "path": str(path), "count": str(len(batch))})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"prompt_pack: {exc}")

    if "atomic_composer" in include and toloka_rows:
        batch = compose_toloka_prompts(toloka_rows, toloka_keywords, compose_keyword_limit)
        records.extend(batch)
        source_meta.append({"name": "atomic_composer", "path": "in-memory", "count": str(len(batch))})

    if "runtime_bridge" in include and source_paths.get("runtime_bridge"):
        path = source_paths["runtime_bridge"]
        try:
            batch = load_runtime_bridge_prompts(path)
            records.extend(batch)
            source_meta.append({"name": "runtime_bridge", "path": str(path), "count": str(len(batch))})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"runtime_bridge: {exc}")

    filtered = [record for record in records if record_allowed(record, policy)]
    deduped = _dedupe(filtered)

    source_counts: dict[str, int] = {}
    source_kind_counts: dict[str, int] = {}
    for record in deduped:
        source_counts[record.source] = source_counts.get(record.source, 0) + 1
        source_kind_counts[record.source_kind] = source_kind_counts.get(record.source_kind, 0) + 1

    return {
        "schema": "prompt-factory-pool.v1",
        "generated_at_iso": _now_iso(),
        "prompt_count": len(deduped),
        "source_counts": source_counts,
        "source_kind_counts": source_kind_counts,
        "policy": policy.to_dict(),
        "sources": source_meta,
        "errors": errors,
        "prompts": [record.to_dict() for record in deduped],
    }
