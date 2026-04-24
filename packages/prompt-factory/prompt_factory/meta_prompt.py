from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\x00", " ").split()).strip()


def _lower_blob(item: dict[str, Any]) -> str:
    parts = [
        _normalize_text(item.get("source_id")),
        _normalize_text(item.get("title")),
        _normalize_text(item.get("prompt")),
        *[_normalize_text(tag) for tag in (item.get("category_tags") or [])],
        *[_normalize_text(tag) for tag in (item.get("platform_tags") or [])],
        *[_normalize_text(tag) for tag in (item.get("model_tags") or [])],
    ]
    return " ".join(part.lower() for part in parts if part)


def infer_meta_prompt_archetype(item: dict[str, Any]) -> str:
    blob = _lower_blob(item)
    if any(token in blob for token in ("technology", "smart-city", "5g", "antenna", "infrastructure", "infographic")):
        return "technology_infographic"
    if any(token in blob for token in ("surveillance", "cctv", "thermal", "night vision", "facial recognition", "drone")):
        return "surveillance"
    if any(token in blob for token in ("journey-to-the-west", "wuxia", "martial-arts", "sword", "gu long")):
        return "wuxia_confrontation"
    if any(token in blob for token in ("space", "planetary", "saturn", "jupiter", "mars", "neptune", "venus", "orbital")):
        return "space_planetary"
    if any(token in blob for token in ("underwater", "ink-painting", "portrait", "hanfu", "mythic")):
        return "underwater_portrait"
    if any(token in blob for token in ("travel-poster", "retro-poster", "travel", "poster", "vintage travel")):
        return "travel_poster"
    return "generic"


def build_meta_prompt_skeleton(item: dict[str, Any]) -> str:
    archetype = infer_meta_prompt_archetype(item)
    mapping = {
        "technology_infographic": (
            "hero infrastructure/system x capability taxonomy x labeled component overlays x "
            "environment context x color-coded signal language x dramatic lighting/material realism x poster composition"
        ),
        "travel_poster": (
            "location-led subject x focal transport/object motif x layered landmark backdrop x "
            "sky/weather/light mood x bold travel-poster palette x print texture/illustration medium x poster typography"
        ),
        "underwater_portrait": (
            "central character portrait x immersive fluid environment x symbolic companion motifs x "
            "costume/ornament details x directional light and particles x controlled color story x shallow-focus cinematic framing"
        ),
        "wuxia_confrontation": (
            "opposed protagonists x weapon/symbol tension x environment as pressure field x wardrobe contrast x "
            "restrained high-contrast lighting x negative-space composition x title typography"
        ),
        "surveillance": (
            "capture mode/device aesthetic x observed subject/action x monitored environment x "
            "analytic overlays/readouts x intentional image degradation x institutional mood"
        ),
        "space_planetary": (
            "celestial subject x mission-vantage geometry x scale cue x light-shadow event x "
            "raw imaging texture x isolation/tension mood"
        ),
        "generic": (
            "primary subject x supporting motif x environment layers x lighting/time x "
            "palette/material cues x composition x rendering texture"
        ),
    }
    return mapping[archetype]


def _find_json_object_bounds(raw_text: str, anchor: int) -> tuple[int, int]:
    object_stack: list[int] = []
    in_string = False
    escaped = False

    for index, char in enumerate(raw_text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == "{":
                object_stack.append(index)
            elif char == "}":
                if object_stack:
                    object_stack.pop()
        if index >= anchor:
            break

    if not object_stack:
        raise ValueError("could not locate JSON object start for source_id")

    start = object_stack[-1]
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(raw_text)):
        char = raw_text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return start, index + 1

    raise ValueError("could not locate JSON object end for source_id")


def _rewrite_manual_prompt_text(
    raw_text: str,
    *,
    source_id: str,
    meta_prompt: str,
) -> str:
    source_id_literal = json.dumps(source_id, ensure_ascii=False)
    anchor = raw_text.find(f'"source_id": {source_id_literal}')
    if anchor < 0:
        raise KeyError(f"manual_gpt source_id not found in raw text: {source_id}")

    start, end = _find_json_object_bounds(raw_text, anchor)
    object_text = raw_text[start:end]
    meta_prompt_literal = json.dumps(meta_prompt, ensure_ascii=False)
    existing_match = re.search(r'("meta_prompt"\s*:\s*)("(?:[^"\\]|\\.)*")', object_text)
    if existing_match:
        updated_object_text = (
            object_text[: existing_match.start(2)]
            + meta_prompt_literal
            + object_text[existing_match.end(2) :]
        )
    else:
        lines = object_text.splitlines()
        if len(lines) < 2:
            raise ValueError("manual_gpt prompt object is unexpectedly compact")
        property_indent = None
        for line in lines:
            indent_match = re.match(r'^(\s*)"', line)
            if indent_match:
                property_indent = indent_match.group(1)
                break
        if property_indent is None:
            raise ValueError("could not infer property indentation for manual_gpt prompt")
        if not lines[-2].rstrip().endswith(","):
            lines[-2] = f"{lines[-2]},"
        lines.insert(-1, f'{property_indent}"meta_prompt": {meta_prompt_literal}')
        updated_object_text = "\n".join(lines)

    updated_raw_text = f"{raw_text[:start]}{updated_object_text}{raw_text[end:]}"
    json.loads(updated_raw_text)
    return updated_raw_text


def update_manual_meta_prompt(
    path: Path,
    *,
    source_id: str,
    force: bool = False,
) -> dict[str, Any]:
    raw_text = path.read_text(encoding="utf-8")
    payload = json.loads(raw_text)
    if payload.get("schema") != "prompt-factory-manual-gpt-prompts.v1":
        raise ValueError(f"unsupported manual prompt schema in {path}")
    prompts = payload.get("prompts")
    if not isinstance(prompts, list):
        raise ValueError(f"invalid prompts list in {path}")

    for item in prompts:
        if not isinstance(item, dict):
            continue
        if _normalize_text(item.get("source_id")) != _normalize_text(source_id):
            continue
        previous = _normalize_text(item.get("meta_prompt"))
        if previous and not force:
            return {
                "updated": False,
                "reason": "meta_prompt already exists",
                "source_id": source_id,
                "meta_prompt": previous,
                "path": str(path),
            }
        generated = build_meta_prompt_skeleton(item)
        item["meta_prompt"] = generated
        updated_raw_text = _rewrite_manual_prompt_text(
            raw_text,
            source_id=source_id,
            meta_prompt=generated,
        )
        path.write_text(updated_raw_text, encoding="utf-8")
        return {
            "updated": True,
            "source_id": source_id,
            "meta_prompt": generated,
            "path": str(path),
            "archetype": infer_meta_prompt_archetype(item),
        }

    raise KeyError(f"manual_gpt source_id not found: {source_id}")
