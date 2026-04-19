from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class PromptPolicy:
    allow_humans: bool = False
    allow_reference_required: bool = False
    min_prompt_chars: int = 0
    blocked_terms: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PromptRecord:
    id: str
    canonical_id: str
    source: str
    source_id: str
    number: str
    title: str
    prompt: str
    source_kind: str
    quality_tier: str
    platform_tags: list[str]
    model_tags: list[str]
    category_tags: list[str]
    selection_score: int
    quality: dict[str, Any]
    metadata: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
