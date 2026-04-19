from __future__ import annotations

import re
from pathlib import Path

from prompt_factory.filters import build_prompt_record, unique_list
from prompt_factory.models import PromptRecord

SECTION_HEADING_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)
CASE_HEADING_RE = re.compile(
    r"^###\s+Case\s+(?P<number>\d+):\s+\[(?P<title>[^\]]+)\]\((?P<case_url>[^)]+)\)"
    r"\s+\(by\s+\[(?P<author>[^\]]+)\]\((?P<author_url>[^)]+)\)\)\s*$",
    re.MULTILINE,
)
PROMPT_BLOCK_RE = re.compile(r"\*\*Prompt:\*\*\s*```(?:[\w-]+)?\n(?P<prompt>.*?)\n```", re.DOTALL)


def _slugify(value: str) -> str:
    lowered = value.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
    return slug or "general"


def _section_spans(markdown: str) -> list[tuple[str, int, int]]:
    matches = list(SECTION_HEADING_RE.finditer(markdown))
    spans: list[tuple[str, int, int]] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        spans.append((match.group("title").strip(), start, end))
    return spans


def _platform_tags_for_section(section_slug: str) -> list[str]:
    if "ui" in section_slug or "mockup" in section_slug or "social-media" in section_slug:
        return ["app", "web-design", "social-media"]
    if "poster" in section_slug or "illustration" in section_slug:
        return ["poster", "illustration"]
    if "character" in section_slug:
        return ["character-design", "reference-sheet"]
    if "comparison" in section_slug or "community" in section_slug:
        return ["general", "comparison"]
    if "portrait" in section_slug or "photography" in section_slug:
        return ["portrait", "photography"]
    return ["general"]


def load_awesome_gpt_image_2_prompts(root: Path) -> list[PromptRecord]:
    readme_path = root / "README.md"
    markdown = readme_path.read_text(encoding="utf-8")
    records: list[PromptRecord] = []

    for section_title, section_start, section_end in _section_spans(markdown):
        if section_title in {"Introduction", "News", "Menu", "Acknowledge"}:
            continue
        section_slug = _slugify(section_title)
        section_markdown = markdown[section_start:section_end]

        for case_match in CASE_HEADING_RE.finditer(section_markdown):
            case_title = case_match.group("title").strip()
            case_number = case_match.group("number").strip()
            case_start = case_match.end()
            next_case = CASE_HEADING_RE.search(section_markdown, case_start)
            case_end = next_case.start() if next_case else len(section_markdown)
            case_block = section_markdown[case_start:case_end]
            prompt_match = PROMPT_BLOCK_RE.search(case_block)
            if not prompt_match:
                continue
            prompt = prompt_match.group("prompt").strip()
            if not prompt:
                continue

            source_id = f"{section_slug}-case-{case_number}"
            records.append(
                build_prompt_record(
                    source="awesome-gpt-image-2-prompts",
                    source_id=source_id,
                    number=case_number,
                    title=case_title,
                    prompt=prompt,
                    source_kind="direct",
                    quality_tier="high",
                    platform_tags=_platform_tags_for_section(section_slug),
                    model_tags=["gpt-image-2", "gpt-image"],
                    category_tags=unique_list([section_slug, section_title]),
                    metadata={
                        "adapter": "awesome_gpt_image_2",
                        "repo_root": str(root),
                        "readme_path": str(readme_path),
                        "section_title": section_title,
                        "section_slug": section_slug,
                        "case_title": case_title,
                        "case_number": case_number,
                        "case_url": case_match.group("case_url").strip(),
                        "author": case_match.group("author").strip(),
                        "author_url": case_match.group("author_url").strip(),
                    },
                )
            )

    return records
