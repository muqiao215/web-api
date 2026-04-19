from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from prompt_factory.filters import build_prompt_record, normalize_text, unique_list
from prompt_factory.models import PromptRecord

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


def _load_yaml_like(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if yaml is not None:
        data = yaml.safe_load(text)
        if isinstance(data, dict):
            return data
    data = json.loads(text)
    if isinstance(data, dict):
        return data
    return {}


def load_stable_diffusion_templates(root: Path) -> list[PromptRecord]:
    records: list[PromptRecord] = []
    for path in sorted((root / "images").glob("*.yaml")):
        if "comparison" in path.parts:
            continue
        data = _load_yaml_like(path)
        prompt = normalize_text(data.get("prompt"))
        if not prompt:
            continue
        slug = path.stem
        record = build_prompt_record(
            source="stable-diffusion-prompt-templates",
            source_id=str(path.relative_to(root)),
            number=slug,
            title=slug.replace("_", " ").replace("-", " ").title(),
            prompt=prompt,
            source_kind="direct",
            quality_tier="medium",
            platform_tags=["general", "style-template"],
            model_tags=unique_list(
                [normalize_text(data.get("model")), "stable-diffusion", "flux", "universal-image-model"]
            ),
            category_tags=[slug],
            metadata={
                "adapter": "stable_diffusion_templates",
                "template_path": str(path),
                "model": normalize_text(data.get("model")),
                "sampler_name": normalize_text(data.get("sampler_name")),
                "steps": data.get("steps"),
                "seed": data.get("seed"),
                "width": (data.get("size") or {}).get("width") if isinstance(data.get("size"), dict) else "",
                "height": (data.get("size") or {}).get("height") if isinstance(data.get("size"), dict) else "",
                "source_repo": "https://github.com/Dalabad/stable-diffusion-prompt-templates",
            },
        )
        records.append(record)
    return records
