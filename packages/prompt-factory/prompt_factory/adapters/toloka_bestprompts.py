from __future__ import annotations

import csv
from pathlib import Path

from prompt_factory.filters import build_prompt_record, normalize_text, unique_list
from prompt_factory.models import PromptRecord


def _read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _toloka_rows(root: Path) -> list[dict[str, str]]:
    rows_out: list[dict[str, str]] = []
    for index, row in enumerate(_read_csv_rows(root / "prompts.csv"), start=1):
        raw_prompt = normalize_text(row.get("Prompt"))
        filtered = normalize_text(row.get("Filtered"))
        prompt = filtered or raw_prompt
        if not prompt:
            continue
        rows_out.append(
            {
                "index": str(index),
                "raw_prompt": raw_prompt,
                "filtered_prompt": filtered,
                "prompt": prompt,
                "type": normalize_text(row.get("Type")),
                "orientation": normalize_text(row.get("Orientation")),
                "score": normalize_text(row.get("Unnamed: 6")),
            }
        )
    return rows_out


def _keyword_sets(root: Path) -> list[str]:
    path = root / "uid_to_keywords.csv"
    if not path.exists():
        return []
    values: list[str] = []
    for row in _read_csv_rows(path):
        value = normalize_text(row.get("0"))
        if value:
            values.append(value)
    return unique_list(values)


def load_toloka_prompts(root: Path) -> tuple[list[PromptRecord], list[dict[str, str]], list[str]]:
    rows = _toloka_rows(root)
    records: list[PromptRecord] = []
    for row in rows:
        record = build_prompt_record(
            source="toloka-bestprompts",
            source_id=f"toloka-{row['index']}",
            number=row["index"],
            title=row["prompt"][:96],
            prompt=row["prompt"],
            source_kind="atomic",
            quality_tier="medium",
            platform_tags=["general", "research-dataset"],
            model_tags=["stable-diffusion", "universal-image-model"],
            category_tags=unique_list([row["type"], row["orientation"]]),
            metadata={
                "adapter": "toloka_bestprompts",
                "raw_prompt": row["raw_prompt"],
                "type": row["type"],
                "orientation": row["orientation"],
                "score": row["score"],
                "source_path": str(root / "prompts.csv"),
            },
        )
        records.append(record)
    return records, rows, _keyword_sets(root)


def compose_toloka_prompts(base_rows: list[dict[str, str]], keyword_sets: list[str], limit: int = 55) -> list[PromptRecord]:
    records: list[PromptRecord] = []
    if limit > 0:
        keyword_sets = keyword_sets[:limit]
    for row in base_rows:
        base_prompt = row["prompt"]
        type_tag = row["type"] or "general"
        orientation_tag = row["orientation"] or "any"
        base_title = (row["filtered_prompt"] or base_prompt)[:96]
        for index, keyword_set in enumerate(keyword_sets, start=1):
            prompt = normalize_text(
                f"{base_prompt}. Style keywords: {keyword_set}. Keep the image coherent, polished, and visually striking."
            )
            record = build_prompt_record(
                source="atomic-composer",
                source_id=f"toloka-style-{row['index']}-{index}",
                number=f"style-{row['index']}-{index}",
                title=f"{base_title[:72]} / style set {index}",
                prompt=prompt,
                source_kind="composed",
                quality_tier="experimental",
                platform_tags=["general", "composed"],
                model_tags=["stable-diffusion", "universal-image-model"],
                category_tags=unique_list([type_tag, orientation_tag, "style-composed"]),
                metadata={
                    "adapter": "toloka_bestprompts.compose",
                    "composition_kind": "toloka-prompt-x-keyword-set",
                    "base_prompt_index": row["index"],
                    "base_prompt": base_prompt,
                    "keyword_set_index": index,
                    "keyword_set": keyword_set,
                },
            )
            records.append(record)
    return records
