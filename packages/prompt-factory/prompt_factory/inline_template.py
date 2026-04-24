from __future__ import annotations

import re
from typing import Any

INLINE_ARGUMENT_RE = re.compile(
    r'\{argument\s+name="(?P<name>[^"]+)"(?:\s+default="(?P<default>[^"]*)")?\}',
    re.IGNORECASE,
)


def has_inline_argument_placeholders(prompt_text: str) -> bool:
    return bool(INLINE_ARGUMENT_RE.search(str(prompt_text or "")))


def extract_template_fields(prompt_text: str) -> list[dict[str, str]]:
    fields: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for match in INLINE_ARGUMENT_RE.finditer(str(prompt_text or "")):
        name = match.group("name").strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        fields.append(
            {
                "name": name,
                "default": (match.group("default") or "").strip(),
            }
        )
    return fields


def render_template(prompt_text: str, values: dict[str, Any] | None = None) -> str:
    provided = values or {}

    def _replace(match: re.Match[str]) -> str:
        name = match.group("name").strip()
        default = (match.group("default") or "").strip()
        if name in provided:
            value = str(provided[name]).strip()
            if value:
                return value
        if default:
            return default
        return match.group(0)

    return INLINE_ARGUMENT_RE.sub(_replace, str(prompt_text or ""))
