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
from prompt_factory.meta_prompt import update_manual_meta_prompt
from prompt_factory.models import PromptPolicy
from prompt_factory.operations import (
    collect_source_snapshots,
    diff_manifest_pair,
    find_previous_manifest,
    load_source_registry,
    pool_fingerprint,
    promote_manifest,
    source_paths_from_registry,
    sync_sources,
    now_iso,
    write_build_tracking,
    write_diff_tracking,
)

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent
WORKSPACE = Path(os.environ.get("PROMPT_FACTORY_WORKSPACE_ROOT", PROJECT_ROOT.parents[2]))
DEFAULT_SOURCE_REGISTRY = PROJECT_ROOT / "sources" / "source_registry.json"
DEFAULT_STATE_DIR = PROJECT_ROOT / "state"
DEFAULT_PROMOTED_ROOT = PROJECT_ROOT / "builds" / "promoted"

PROFILE_SOURCES = {
    "local_repos": [
        "youmind",
        "toloka",
        "stable_diffusion",
        "prompt_pack",
        "awesome_gpt_image_2",
        "manual_gpt",
        "atomic_composer",
    ],
    "runtime_bridge": ["runtime_bridge"],
}


def _build_profile(profile: str, output_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    registry = load_source_registry(Path(args.source_registry), WORKSPACE)
    source_paths = source_paths_from_registry(registry)
    include_sources = PROFILE_SOURCES[profile]
    tracked_sources = [source for source in include_sources if source in registry]
    source_snapshots = collect_source_snapshots(registry, include_sources=tracked_sources)
    pool = build_prompt_pool(
        source_paths,
        include_sources=include_sources,
        compose_keyword_limit=args.compose_keyword_limit,
        policy=PromptPolicy(
            allow_humans=args.allow_humans,
            allow_reference_required=args.allow_reference_required,
        ),
    )
    pool["source_snapshots"] = source_snapshots
    pool["pool_fingerprint"] = pool_fingerprint(pool)
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
    source_revision_map = {
        source_id: snapshot.get("revision", "")
        for source_id, snapshot in source_snapshots.items()
    }
    manifest = {
        "schema": "prompt-factory-build-manifest.v2",
        "profile": profile,
        "generated_at_iso": now_iso(),
        "workspace_root": str(WORKSPACE),
        "input_sources": include_sources,
        "prompt_count": pool["prompt_count"],
        "source_counts": pool["source_counts"],
        "source_kind_counts": pool["source_kind_counts"],
        "source_snapshots": source_snapshots,
        "source_revision_map": source_revision_map,
        "pool_fingerprint": pool["pool_fingerprint"],
        "errors": pool.get("errors") or [],
        "paths": {
            "unified": str(profile_root / "unified" / "prompt_pool.json"),
            "gpt": str(profile_root / "providers" / "gpt" / "prompt_pool.json"),
            "banana": str(profile_root / "providers" / "banana" / "banana_prompts.json"),
            "used_index_seed": str(profile_root / "indices" / "used_prompt_ids.seed.json"),
        },
    }
    manifest_path = profile_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_build_tracking(state_dir=Path(args.state_dir), profile=profile, manifest_path=manifest_path, manifest=manifest)
    return manifest


def build_command(args: argparse.Namespace) -> int:
    output_root = Path(args.output_root)
    profiles = [args.profile] if args.profile != "all" else ["local_repos", "runtime_bridge"]
    results = [_build_profile(profile, output_root, args) for profile in profiles]
    print(json.dumps({"profiles": results}, ensure_ascii=False, indent=2))
    return 0


def sync_command(args: argparse.Namespace) -> int:
    registry = load_source_registry(Path(args.source_registry), WORKSPACE)
    result = sync_sources(registry, state_dir=Path(args.state_dir), include_sources=args.source)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(item["status"] in {"blocked", "error", "missing"} for item in result["results"]) else 0


def _resolve_baseline_manifest(args: argparse.Namespace, current_manifest: Path) -> Path:
    if args.baseline:
        if args.baseline == "stable":
            return Path(args.promoted_root) / args.profile / "manifest.json"
        if args.baseline == "previous":
            previous = find_previous_manifest(Path(args.state_dir), args.profile, current_manifest)
            if previous is None:
                raise FileNotFoundError(f"no previous build manifest found for profile={args.profile}")
            return previous
        return Path(args.baseline)

    stable = Path(args.promoted_root) / args.profile / "manifest.json"
    if stable.exists():
        return stable
    previous = find_previous_manifest(Path(args.state_dir), args.profile, current_manifest)
    if previous is None:
        raise FileNotFoundError(
            f"no promoted or previous build manifest found for profile={args.profile}; run build twice or promote once"
        )
    return previous


def diff_command(args: argparse.Namespace) -> int:
    current_manifest = Path(args.current_manifest) if args.current_manifest else Path(args.output_root) / args.profile / "manifest.json"
    baseline_manifest = _resolve_baseline_manifest(args, current_manifest)
    summary = diff_manifest_pair(current_manifest, baseline_manifest)
    write_diff_tracking(Path(args.state_dir), summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def promote_command(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest) if args.manifest else Path(args.output_root) / args.profile / "manifest.json"
    promoted = promote_manifest(
        profile=args.profile,
        manifest_path=manifest_path,
        promoted_root=Path(args.promoted_root),
        state_dir=Path(args.state_dir),
    )
    print(json.dumps(promoted, ensure_ascii=False, indent=2))
    return 0


def meta_prompt_command(args: argparse.Namespace) -> int:
    result = update_manual_meta_prompt(
        Path(args.manual_path),
        source_id=args.source_id,
        force=args.force,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace-root", default=str(WORKSPACE))
    parser.add_argument("--source-registry", default=str(DEFAULT_SOURCE_REGISTRY))
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prompt_factory", description="Build unified prompt pools and provider exports.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    sync = subparsers.add_parser("sync", help="Refresh tracked source repositories and source snapshots")
    add_common_args(sync)
    sync.add_argument("--source", action="append", help="Limit sync to one source_id; repeatable")
    sync.set_defaults(func=sync_command)

    build = subparsers.add_parser("build", help="Build one or more prompt profiles")
    add_common_args(build)
    build.add_argument("--profile", choices=["local_repos", "runtime_bridge", "all"], default="all")
    build.add_argument("--output-root", default=str(PROJECT_ROOT / "builds"))
    build.add_argument("--compose-keyword-limit", type=int, default=55)
    build.add_argument("--banana-min-chars", type=int, default=0)
    build.add_argument("--banana-max-prompts", type=int, default=5000)
    build.add_argument("--allow-humans", dest="allow_humans", action="store_true", default=True)
    build.add_argument("--disallow-humans", dest="allow_humans", action="store_false")
    build.add_argument(
        "--allow-reference-required",
        dest="allow_reference_required",
        action="store_true",
        default=True,
    )
    build.add_argument(
        "--disallow-reference-required",
        dest="allow_reference_required",
        action="store_false",
    )
    build.set_defaults(func=build_command)

    diff = subparsers.add_parser("diff", help="Compare a build manifest against stable or previous build")
    add_common_args(diff)
    diff.add_argument("--profile", choices=["local_repos", "runtime_bridge"], default="local_repos")
    diff.add_argument("--output-root", default=str(PROJECT_ROOT / "builds"))
    diff.add_argument("--promoted-root", default=str(DEFAULT_PROMOTED_ROOT))
    diff.add_argument("--current-manifest", default="")
    diff.add_argument("--baseline", default="", help="'stable', 'previous', or a manifest path")
    diff.set_defaults(func=diff_command)

    promote = subparsers.add_parser("promote", help="Promote a verified build as latest stable")
    add_common_args(promote)
    promote.add_argument("--profile", choices=["local_repos", "runtime_bridge"], default="local_repos")
    promote.add_argument("--output-root", default=str(PROJECT_ROOT / "builds"))
    promote.add_argument("--promoted-root", default=str(DEFAULT_PROMOTED_ROOT))
    promote.add_argument("--manifest", default="")
    promote.set_defaults(func=promote_command)

    meta_prompt = subparsers.add_parser("meta-prompt", help="Generate a meta_prompt skeleton for one manual GPT prompt")
    meta_prompt.add_argument("--workspace-root", default=str(WORKSPACE))
    meta_prompt.add_argument(
        "--manual-path",
        default=str(PROJECT_ROOT / "sources" / "manual_gpt_prompts.json"),
    )
    meta_prompt.add_argument("--source-id", required=True)
    meta_prompt.add_argument("--force", action="store_true")
    meta_prompt.set_defaults(func=meta_prompt_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    global WORKSPACE  # noqa: PLW0603
    WORKSPACE = Path(args.workspace_root)
    return args.func(args)
