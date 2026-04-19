from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from prompt_factory.builder import build_prompt_pool
from prompt_factory.exporters import (
    export_banana_prompts,
    export_gpt_prompt_pool,
    export_unified_pool,
    export_used_index_seed,
)
from prompt_factory.models import PromptPolicy

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent
WORKSPACE = Path(os.environ.get("PROMPT_FACTORY_WORKSPACE_ROOT", PROJECT_ROOT.parents[2]))

DEFAULT_SOURCE_PATHS = {
    "youmind": WORKSPACE / "ai-image-prompts-skill.J5v2Vt",
    "toloka": WORKSPACE / "BestPrompts.tmp",
    "stable_diffusion": WORKSPACE / "stable-diffusion-prompt-templates.ASMlaX",
    "prompt_pack": WORKSPACE / "prompt-pack.tmp",
    "awesome_gpt_image_2": WORKSPACE / "awesome-gpt-image-2-prompts",
    "runtime_bridge": WORKSPACE / "telegram_gpt_image_bot" / "state" / "prompt_pool.json",
}

PROFILE_SOURCES = {
    "local_repos": ["youmind", "toloka", "stable_diffusion", "prompt_pack", "awesome_gpt_image_2", "atomic_composer"],
    "runtime_bridge": ["runtime_bridge"],
}


def _build_profile(profile: str, output_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    pool = build_prompt_pool(
        DEFAULT_SOURCE_PATHS,
        include_sources=PROFILE_SOURCES[profile],
        compose_keyword_limit=args.compose_keyword_limit,
        policy=PromptPolicy(
            allow_humans=args.allow_humans,
            allow_reference_required=args.allow_reference_required,
        ),
    )
    profile_root = output_root / profile
    export_unified_pool(pool, profile_root / "unified" / "prompt_pool.json")
    export_gpt_prompt_pool(pool, profile_root / "providers" / "gpt" / "prompt_pool.json")
    export_banana_prompts(
        pool,
        profile_root / "providers" / "banana" / "banana_prompts.json",
        max_prompts=args.banana_max_prompts,
        min_chars=args.banana_min_chars,
    )
    export_used_index_seed(profile_root / "indices" / "used_prompt_ids.seed.json")
    manifest = {
        "profile": profile,
        "prompt_count": pool["prompt_count"],
        "source_counts": pool["source_counts"],
        "errors": pool.get("errors") or [],
        "paths": {
            "unified": str(profile_root / "unified" / "prompt_pool.json"),
            "gpt": str(profile_root / "providers" / "gpt" / "prompt_pool.json"),
            "banana": str(profile_root / "providers" / "banana" / "banana_prompts.json"),
            "used_index_seed": str(profile_root / "indices" / "used_prompt_ids.seed.json"),
        },
    }
    (profile_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def build_command(args: argparse.Namespace) -> int:
    output_root = Path(args.output_root)
    profiles = [args.profile] if args.profile != "all" else ["local_repos", "runtime_bridge"]
    results = [_build_profile(profile, output_root, args) for profile in profiles]
    print(json.dumps({"profiles": results}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prompt_factory", description="Build unified prompt pools and provider exports.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build", help="Build one or more prompt profiles")
    build.add_argument("--profile", choices=["local_repos", "runtime_bridge", "all"], default="all")
    build.add_argument("--output-root", default=str(PROJECT_ROOT / "builds"))
    build.add_argument("--workspace-root", default=str(WORKSPACE))
    build.add_argument("--compose-keyword-limit", type=int, default=55)
    build.add_argument("--banana-min-chars", type=int, default=180)
    build.add_argument("--banana-max-prompts", type=int, default=5000)
    build.add_argument("--allow-humans", action="store_true")
    build.add_argument("--allow-reference-required", action="store_true")
    build.set_defaults(func=build_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    global WORKSPACE  # noqa: PLW0603
    WORKSPACE = Path(args.workspace_root)
    DEFAULT_SOURCE_PATHS.update(
        {
            "youmind": WORKSPACE / "ai-image-prompts-skill.J5v2Vt",
            "toloka": WORKSPACE / "BestPrompts.tmp",
            "stable_diffusion": WORKSPACE / "stable-diffusion-prompt-templates.ASMlaX",
            "prompt_pack": WORKSPACE / "prompt-pack.tmp",
            "awesome_gpt_image_2": WORKSPACE / "awesome-gpt-image-2-prompts",
            "runtime_bridge": WORKSPACE / "telegram_gpt_image_bot" / "state" / "prompt_pool.json",
        }
    )
    return args.func(args)
