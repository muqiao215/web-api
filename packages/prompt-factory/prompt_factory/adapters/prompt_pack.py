from __future__ import annotations

import csv
import io
import re
import urllib.request
from pathlib import Path

from prompt_factory.filters import build_prompt_record, normalize_text
from prompt_factory.models import PromptRecord

PROMPT_PACK_LOCAL_CSV_CANDIDATES = (
    "prompt-pack.csv",
    "prompt_pack.csv",
    "data/prompt-pack.csv",
    "data/prompt_pack.csv",
    "exports/prompt-pack.csv",
    "exports/prompt_pack.csv",
    "cache/prompt-pack.csv",
    "cache/prompt_pack.csv",
)
PROMPT_PACK_SHEET_RE = re.compile(r"https://docs\.google\.com/spreadsheets/d/([a-zA-Z0-9-_]+)")
PROMPT_PACK_MOOD_COLUMNS = (
    "Mood",
    "Emotion",
    "Emotional Tone",
    "A mix of traditional pigments used in painting as well as colors that are popular in various art forms. "
    "Below is a list of emotions the colors might invoke when used in art.",
)


def _sheet_csv_url(sheet_id: str) -> str:
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv"


def _parse_csv_text(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


def _load_rows_from_local_csv(path: Path) -> list[dict[str, str]]:
    return _parse_csv_text(path.read_text(encoding="utf-8-sig"))


def _discover_local_csv(root: Path) -> Path | None:
    for relative in PROMPT_PACK_LOCAL_CSV_CANDIDATES:
        candidate = root / relative
        if candidate.exists():
            return candidate
    csv_files = sorted(path for path in root.rglob("*.csv") if path.is_file())
    return csv_files[0] if csv_files else None


def _discover_sheet_id(root: Path) -> str | None:
    readme = root / "README.md"
    if not readme.exists():
        return None
    match = PROMPT_PACK_SHEET_RE.search(readme.read_text(encoding="utf-8"))
    return match.group(1) if match else None


def _load_remote_rows(root: Path) -> tuple[list[dict[str, str]], str]:
    sheet_id = _discover_sheet_id(root)
    if not sheet_id:
        raise FileNotFoundError(f"no local CSV export or Google Sheet link found in {root}")
    url = _sheet_csv_url(sheet_id)
    with urllib.request.urlopen(url, timeout=30) as response:
        text = response.read().decode("utf-8-sig")
    return _parse_csv_text(text), url


def _extract_mood(row: dict[str, str]) -> str:
    for key in PROMPT_PACK_MOOD_COLUMNS:
        value = normalize_text(row.get(key))
        if value:
            return value
    return ""


def load_prompt_pack_prompts(root: Path) -> list[PromptRecord]:
    source_detail = ""
    local_csv = _discover_local_csv(root)
    if local_csv is not None:
        rows = _load_rows_from_local_csv(local_csv)
        source_detail = str(local_csv)
    else:
        rows, source_detail = _load_remote_rows(root)

    records: list[PromptRecord] = []
    for index, row in enumerate(rows, start=1):
        color = normalize_text(row.get("Colors") or row.get("Color"))
        obj = normalize_text(row.get("Object") or row.get("Subject") or row.get("Motif"))
        mood = _extract_mood(row)
        if not color or not obj:
            continue
        prompt = normalize_text(
            f"Create a visually striking image featuring {obj}, using the {color} color palette."
            + (f" Emotional tone: {mood}." if mood else "")
        )
        record = build_prompt_record(
            source="hoppycat-prompt-pack",
            source_id=f"hoppycat-{index}",
            number=str(index),
            title=f"{color} {obj[:72]}".strip(),
            prompt=prompt,
            source_kind="atomic",
            quality_tier="medium",
            platform_tags=["general", "palette"],
            model_tags=["universal-image-model"],
            category_tags=["palette", "color-mood"],
            metadata={
                "adapter": "prompt_pack",
                "color": color,
                "object": obj,
                "mood": mood,
                "source_detail": source_detail,
                "repo_root": str(root),
            },
        )
        records.append(record)
    return records
