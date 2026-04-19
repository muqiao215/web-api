from __future__ import annotations

from pathlib import Path

from prompt_factory.filters import build_prompt_record, derive_platform_tags, normalize_text, unique_list
from prompt_factory.models import PromptRecord


def load_youmind_skill_prompts(root: Path) -> list[PromptRecord]:
    manifest_path = root / "references" / "manifest.json"
    manifest = __import__("json").loads(manifest_path.read_text(encoding="utf-8"))
    categories = manifest.get("categories") if isinstance(manifest, dict) else None
    if not isinstance(categories, list):
        return []

    records: list[PromptRecord] = []
    for category in categories:
        if not isinstance(category, dict):
            continue
        file_name = normalize_text(category.get("file"))
        if not file_name:
            continue
        data = __import__("json").loads((root / "references" / file_name).read_text(encoding="utf-8"))
        items = data if isinstance(data, list) else (data.get("prompts") or data.get("items") or [])
        if not isinstance(items, list):
            continue
        category_slug = normalize_text(category.get("slug"))
        category_title = normalize_text(category.get("title"))
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("needReferenceImages"):
                continue
            prompt = normalize_text(item.get("content"))
            if not prompt:
                continue
            source_media = item.get("sourceMedia") if isinstance(item.get("sourceMedia"), list) else []
            item_id = str(item.get("id") or "")
            record = build_prompt_record(
                source="youmind-ai-image-prompts-skill",
                source_id=f"{category_slug}-{item_id}" if item_id else category_slug,
                number=item_id or str(len(records) + 1),
                title=normalize_text(item.get("title")) or prompt[:96],
                prompt=prompt,
                source_kind="direct",
                quality_tier="high",
                platform_tags=derive_platform_tags(category_slug),
                model_tags=["universal-image-model"],
                category_tags=unique_list([category_slug, category_title]),
                metadata={
                    "adapter": "youmind_skill",
                    "category_slug": category_slug,
                    "category_title": category_title,
                    "description": normalize_text(item.get("description")),
                    "sample_image": source_media[0] if source_media else "",
                    "sample_image_count": len(source_media),
                    "need_reference_images": False,
                    "manifest_updated_at": manifest.get("updatedAt"),
                    "manifest_total_prompts": manifest.get("totalPrompts"),
                    "manifest_path": str(manifest_path),
                },
            )
            records.append(record)
    return records
