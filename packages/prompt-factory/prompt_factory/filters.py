from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from prompt_factory.inline_template import extract_template_fields, has_inline_argument_placeholders
from prompt_factory.models import PromptPolicy, PromptRecord

DEFAULT_PLATFORM_MAP = {
    "profile-avatar": ["avatar", "social-profile"],
    "social-media-post": ["social-media", "content-cover"],
    "infographic-edu-visual": ["education", "infographic"],
    "youtube-thumbnail": ["youtube", "thumbnail"],
    "comic-storyboard": ["comic", "storyboard"],
    "product-marketing": ["marketing", "ecommerce"],
    "ecommerce-main-image": ["ecommerce", "product-listing"],
    "game-asset": ["game", "asset"],
    "poster-flyer": ["poster", "flyer"],
    "app-web-design": ["app", "web-design"],
    "others": ["general"],
}

HUMAN_RELATED_MARKERS = [
    " selfie",
    "selfie ",
    "young woman",
    "young man",
    "woman ",
    " man ",
    " women",
    " men",
    "girl ",
    "boy ",
    "female",
    "male",
    "person",
    "people",
    "face",
    "facial",
    "eyes",
    "lips",
    "hair",
    "body",
    "chest",
    "waist",
    "skin",
    "model",
    "celebrity",
    "influencer",
    "schoolgirl",
    "korean",
    "japanese woman",
    "japanese girl",
    "asian woman",
    "bathroom mirror",
    "mirror selfie",
    "wearing",
    "outfit",
    "makeup",
    "reclining",
    "styled as",
    "attire",
]

REFERENCE_HINTS = [
    "uploaded person",
    "uploaded reference",
    "uploaded image",
    "reference image",
    "reference photo",
    "same girl as reference",
    "same face as reference",
    "from the uploaded",
    "from photo",
    "provided image",
    "input image",
    "preserving the exact facial structure",
    "recreate the uploaded",
]

ORNATE_MARKERS = [
    "ultra-realistic",
    "photorealistic",
    "cinematic",
    "dramatic",
    "intricate",
    "luminous",
    "atmospheric",
    "editorial",
    "volumetric",
    "composition",
    "texture",
    "lighting",
    "ornate",
    "surreal",
    "high-detail",
    "high resolution",
    "macro",
    "hyper-realistic",
    "moody",
    "studio lighting",
]


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\x00", " ").split()).strip()


def unique_list(values: list[str] | tuple[str, ...] | None) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values or []:
        clean = normalize_text(value)
        if not clean or clean in seen:
            continue
        seen.add(clean)
        out.append(clean)
    return out


def sha1_text(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def derive_platform_tags(category_slug: str) -> list[str]:
    path = Path(__file__).resolve().parent / "taxonomies" / "platform_map.json"
    data = load_json(path, DEFAULT_PLATFORM_MAP)
    if not isinstance(data, dict):
        data = DEFAULT_PLATFORM_MAP
    values = data.get(category_slug)
    if isinstance(values, list):
        return unique_list([str(item) for item in values])
    return ["general"]


def prompt_text_is_human_related(content: str) -> bool:
    lowered = f" {content.lower()} "
    return any(marker in lowered for marker in HUMAN_RELATED_MARKERS)


def prompt_text_requires_reference(content: str) -> bool:
    lowered = content.lower()
    return any(marker in lowered for marker in REFERENCE_HINTS)


def prompt_ornate_score(content: str) -> int:
    lowered = content.lower()
    score = min(len(content) // 80, 20)
    score += sum(3 for marker in ORNATE_MARKERS if marker in lowered)
    score += min(content.count(",") // 3, 8)
    word_count = len(content.split())
    if word_count >= 40:
        score += 6
    if word_count >= 80:
        score += 6
    return score


def build_prompt_record(
    *,
    source: str,
    source_id: str,
    number: str,
    title: str,
    prompt: str,
    source_kind: str,
    quality_tier: str,
    platform_tags: list[str] | None = None,
    model_tags: list[str] | None = None,
    category_tags: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> PromptRecord:
    clean_prompt = normalize_text(prompt)
    human_related = prompt_text_is_human_related(clean_prompt)
    requires_reference = prompt_text_requires_reference(clean_prompt)
    ornate_score = prompt_ornate_score(clean_prompt)
    selection_score = ornate_score - (1000 if human_related else 0) - (1000 if requires_reference else 0)
    clean_metadata = dict(metadata or {})
    if has_inline_argument_placeholders(clean_prompt) and "template" not in clean_metadata:
        clean_metadata["template"] = {
            "kind": "inline_argument_placeholders",
            "template_text": clean_prompt,
            "fields": extract_template_fields(clean_prompt),
        }
    return PromptRecord(
        id=sha1_text(f"{source}|{source_id}|{clean_prompt}"),
        canonical_id=sha1_text(clean_prompt.lower()),
        source=source,
        source_id=normalize_text(source_id),
        number=normalize_text(number),
        title=normalize_text(title) or clean_prompt[:96],
        prompt=clean_prompt,
        source_kind=normalize_text(source_kind),
        quality_tier=normalize_text(quality_tier),
        platform_tags=unique_list(platform_tags),
        model_tags=unique_list(model_tags),
        category_tags=unique_list(category_tags),
        selection_score=selection_score,
        quality={
            "ornate_score": ornate_score,
            "human_related": human_related,
            "requires_reference": requires_reference,
            "score": selection_score,
        },
        metadata=clean_metadata,
    )


def record_allowed(record: PromptRecord, policy: PromptPolicy | None = None) -> bool:
    policy = policy or PromptPolicy()
    if not policy.allow_humans and bool(record.quality.get("human_related")):
        return False
    if not policy.allow_reference_required and bool(record.quality.get("requires_reference")):
        return False
    if policy.min_prompt_chars and len(record.prompt) < policy.min_prompt_chars:
        return False
    lowered = record.prompt.lower()
    if any(term.lower() in lowered for term in policy.blocked_terms):
        return False
    return True
