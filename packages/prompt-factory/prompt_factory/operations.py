from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SOURCE_REGISTRY_SCHEMA = "prompt-factory-source-registry.v1"
SOURCE_STATE_SCHEMA = "prompt-factory-source-state.v1"
BUILD_HISTORY_SCHEMA = "prompt-factory-build-history.v1"
PROMOTION_SCHEMA = "prompt-factory-promotion.v1"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def append_jsonl(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(data, ensure_ascii=False))
        handle.write("\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    entries: list[dict[str, Any]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        entries.append(json.loads(line))
    return entries


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_source_registry(path: Path, workspace_root: Path) -> dict[str, dict[str, Any]]:
    payload = read_json(path, {})
    if payload.get("schema") != SOURCE_REGISTRY_SCHEMA:
        raise ValueError(f"unsupported source registry schema in {path}")
    registry: dict[str, dict[str, Any]] = {}
    for item in payload.get("sources") or []:
        source_id = str(item["source_id"])
        workspace_path = Path(item["workspace_path"])
        registry[source_id] = {
            **item,
            "resolved_path": str((workspace_root / workspace_path).resolve()),
        }
    return registry


def source_paths_from_registry(registry: dict[str, dict[str, Any]]) -> dict[str, Path]:
    return {
        source_id: Path(spec["resolved_path"])
        for source_id, spec in registry.items()
        if spec.get("sync_mode") in {"git_repo", "file_snapshot"}
    }


def pool_fingerprint(pool: dict[str, Any]) -> str:
    identity = [
        {
            "id": item["id"],
            "canonical_id": item["canonical_id"],
            "source": item["source"],
            "selection_score": item["selection_score"],
        }
        for item in pool.get("prompts") or []
    ]
    return sha256_bytes(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8"))


def _run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, check=False, text=True, capture_output=True)


def _git(cwd: Path, *args: str, check: bool = True) -> str:
    proc = _run(["git", *args], cwd)
    if check and proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"git {' '.join(args)} failed")
    return (proc.stdout or "").strip()


def safe_build_id(timestamp: str) -> str:
    return "".join(char if char.isalnum() else "-" for char in timestamp).strip("-")


def inspect_source(spec: dict[str, Any]) -> dict[str, Any]:
    path = Path(spec["resolved_path"])
    base = {
        "source_id": spec["source_id"],
        "label": spec.get("label") or spec["source_id"],
        "sync_mode": spec["sync_mode"],
        "origin_url": spec.get("origin_url", ""),
        "branch": spec.get("branch", ""),
        "workspace_path": spec.get("workspace_path", ""),
        "resolved_path": str(path),
        "checked_at_iso": now_iso(),
        "exists": path.exists(),
    }
    if spec["sync_mode"] == "git_repo":
        if not (path / ".git").exists():
            return {
                **base,
                "status": "missing",
                "revision": "",
                "remote_revision": "",
                "dirty": None,
                "ahead": None,
                "behind": None,
                "error": "git repository missing",
            }
        branch = spec.get("branch", "main")
        revision = _git(path, "rev-parse", "HEAD")
        dirty = bool(_git(path, "status", "--porcelain"))
        current_branch = _git(path, "rev-parse", "--abbrev-ref", "HEAD")
        remote_ref = f"origin/{branch}"
        remote_revision = _git(path, "rev-parse", remote_ref, check=False)
        ahead = behind = None
        if remote_revision:
            counts = _git(path, "rev-list", "--left-right", "--count", f"HEAD...{remote_ref}")
            left, right = counts.split()
            ahead = int(left)
            behind = int(right)
        return {
            **base,
            "status": "ok",
            "revision": revision,
            "remote_revision": remote_revision,
            "current_branch": current_branch,
            "dirty": dirty,
            "ahead": ahead,
            "behind": behind,
        }
    if spec["sync_mode"] == "file_snapshot":
        if not path.exists():
            return {
                **base,
                "status": "missing",
                "revision": "",
                "size": None,
                "sha256": "",
                "mtime": None,
                "error": "file missing",
            }
        stat = path.stat()
        return {
            **base,
            "status": "ok",
            "revision": sha256_file(path),
            "sha256": sha256_file(path),
            "size": stat.st_size,
            "mtime": int(stat.st_mtime),
        }
    return {
        **base,
        "status": "unsupported",
        "revision": "",
        "error": f"unsupported sync_mode={spec['sync_mode']}",
    }


def collect_source_snapshots(
    registry: dict[str, dict[str, Any]],
    *,
    include_sources: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    snapshots: dict[str, dict[str, Any]] = {}
    allowed = set(include_sources or registry.keys())
    for source_id, spec in registry.items():
        if source_id not in allowed:
            continue
        snapshots[source_id] = inspect_source(spec)
    return snapshots


def sync_sources(
    registry: dict[str, dict[str, Any]],
    *,
    state_dir: Path,
    include_sources: list[str] | None = None,
) -> dict[str, Any]:
    allowed = set(include_sources or registry.keys())
    results: list[dict[str, Any]] = []
    latest_sources: dict[str, Any] = {}

    for source_id, spec in registry.items():
        if source_id not in allowed:
            continue
        if spec["sync_mode"] != "git_repo":
            snapshot = inspect_source(spec)
            result = {
                "source_id": source_id,
                "status": "tracked" if snapshot["status"] == "ok" else snapshot["status"],
                "changed": False,
                "previous_revision": "",
                "current_revision": snapshot.get("revision", ""),
                "detail": "file snapshot refreshed",
                "snapshot": snapshot,
            }
            results.append(result)
            latest_sources[source_id] = snapshot
            continue

        repo_path = Path(spec["resolved_path"])
        before = inspect_source(spec)
        status = "unchanged"
        changed = False
        detail = "already up to date"
        error = ""

        if before["status"] != "ok":
            status = before["status"]
            detail = before.get("error", "source unavailable")
            after = before
        elif before.get("dirty"):
            status = "blocked"
            detail = "repository has local modifications; refusing ff-only sync"
            after = before
        else:
            branch = spec.get("branch", "main")
            fetch = _run(["git", "fetch", "--prune", "origin", branch], repo_path)
            if fetch.returncode != 0:
                status = "error"
                detail = fetch.stderr.strip() or fetch.stdout.strip() or "git fetch failed"
                error = detail
                after = inspect_source(spec)
            else:
                fetched = _git(repo_path, "rev-parse", "FETCH_HEAD")
                if fetched == before.get("revision"):
                    after = inspect_source(spec)
                else:
                    merge = _run(["git", "merge", "--ff-only", "FETCH_HEAD"], repo_path)
                    if merge.returncode != 0:
                        status = "error"
                        detail = merge.stderr.strip() or merge.stdout.strip() or "git merge --ff-only failed"
                        error = detail
                    else:
                        status = "updated"
                        changed = True
                        detail = f"fast-forwarded to {fetched[:12]}"
                    after = inspect_source(spec)

        result = {
            "source_id": source_id,
            "status": status,
            "changed": changed,
            "previous_revision": before.get("revision", ""),
            "current_revision": after.get("revision", ""),
            "detail": detail,
            "error": error,
            "snapshot": after,
        }
        results.append(result)
        latest_sources[source_id] = after

    summary = {
        "schema": SOURCE_STATE_SCHEMA,
        "updated_at_iso": now_iso(),
        "source_count": len(results),
        "changed_sources": [item["source_id"] for item in results if item["changed"]],
        "results": results,
        "sources": latest_sources,
    }
    write_json(state_dir / "source_state.json", summary)
    write_json(state_dir / "last_sync_status.json", summary)
    append_jsonl(
        state_dir / "source_sync_history.jsonl",
        {
            "schema": SOURCE_STATE_SCHEMA,
            "updated_at_iso": summary["updated_at_iso"],
            "results": [
                {
                    "source_id": item["source_id"],
                    "status": item["status"],
                    "changed": item["changed"],
                    "previous_revision": item["previous_revision"],
                    "current_revision": item["current_revision"],
                    "detail": item["detail"],
                }
                for item in results
            ],
        },
    )
    return summary


def write_build_tracking(
    *,
    state_dir: Path,
    profile: str,
    manifest_path: Path,
    manifest: dict[str, Any],
) -> None:
    generated_at_iso = manifest.get("generated_at_iso") or now_iso()
    fingerprint_suffix = str(manifest.get("pool_fingerprint") or "")[:12]
    build_id = safe_build_id(generated_at_iso)
    if fingerprint_suffix:
        build_id = f"{build_id}-{fingerprint_suffix}"
    snapshot_root = state_dir / "build_snapshots" / profile / build_id
    snapshot_paths: dict[str, str] = {}

    for key, source in (manifest.get("paths") or {}).items():
        source_path = Path(source)
        if not source_path.exists():
            continue
        destination = snapshot_root / key / source_path.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
        snapshot_paths[key] = str(destination)

    snapshot_manifest = {
        **manifest,
        "live_manifest_path": str(manifest_path),
        "snapshot_root": str(snapshot_root),
        "paths": snapshot_paths,
    }
    snapshot_manifest_path = snapshot_root / "manifest.json"
    write_json(snapshot_manifest_path, snapshot_manifest)

    entry = {
        "schema": BUILD_HISTORY_SCHEMA,
        "generated_at_iso": generated_at_iso,
        "profile": profile,
        "manifest_path": str(snapshot_manifest_path),
        "live_manifest_path": str(manifest_path),
        "snapshot_root": str(snapshot_root),
        "prompt_count": manifest.get("prompt_count"),
        "pool_fingerprint": manifest.get("pool_fingerprint"),
        "source_revision_map": manifest.get("source_revision_map", {}),
    }
    append_jsonl(state_dir / "build_history.jsonl", entry)
    write_json(state_dir / "last_build_status.json", entry)


def find_previous_manifest(state_dir: Path, profile: str, current_manifest_path: Path) -> Path | None:
    current_manifest_path = current_manifest_path.resolve()
    skipped_current = False
    for entry in reversed(read_jsonl(state_dir / "build_history.jsonl")):
        if entry.get("profile") != profile:
            continue
        candidate = Path(entry.get("manifest_path", ""))
        live_candidate = Path(entry.get("live_manifest_path", ""))
        if not skipped_current and (
            candidate.resolve() == current_manifest_path or live_candidate.resolve() == current_manifest_path
        ):
            skipped_current = True
            continue
        if candidate.exists():
            return candidate
    return None


def _load_manifest_and_pool(manifest_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = read_json(manifest_path, {})
    unified_path = Path(manifest["paths"]["unified"])
    pool = read_json(unified_path, {})
    return manifest, pool


def diff_manifest_pair(current_manifest_path: Path, baseline_manifest_path: Path) -> dict[str, Any]:
    current_manifest, current_pool = _load_manifest_and_pool(current_manifest_path)
    baseline_manifest, baseline_pool = _load_manifest_and_pool(baseline_manifest_path)

    current_ids = {item["id"] for item in current_pool.get("prompts") or []}
    baseline_ids = {item["id"] for item in baseline_pool.get("prompts") or []}
    current_canonical = {item["canonical_id"] for item in current_pool.get("prompts") or []}
    baseline_canonical = {item["canonical_id"] for item in baseline_pool.get("prompts") or []}

    all_sources = set(current_manifest.get("source_counts", {})) | set(baseline_manifest.get("source_counts", {}))
    source_count_delta = {
        source: current_manifest.get("source_counts", {}).get(source, 0) - baseline_manifest.get("source_counts", {}).get(source, 0)
        for source in sorted(all_sources)
    }

    current_revisions = current_manifest.get("source_revision_map", {})
    baseline_revisions = baseline_manifest.get("source_revision_map", {})
    revision_changes = {}
    for source_id in sorted(set(current_revisions) | set(baseline_revisions)):
        current_revision = current_revisions.get(source_id)
        baseline_revision = baseline_revisions.get(source_id)
        if current_revision != baseline_revision:
            revision_changes[source_id] = {
                "previous": baseline_revision,
                "current": current_revision,
            }

    summary = {
        "schema": "prompt-factory-diff.v1",
        "generated_at_iso": now_iso(),
        "current_manifest": str(current_manifest_path),
        "baseline_manifest": str(baseline_manifest_path),
        "profile": current_manifest.get("profile") or baseline_manifest.get("profile"),
        "prompt_count": {
            "current": current_manifest.get("prompt_count", 0),
            "baseline": baseline_manifest.get("prompt_count", 0),
            "delta": current_manifest.get("prompt_count", 0) - baseline_manifest.get("prompt_count", 0),
        },
        "id_delta": {
            "added": len(current_ids - baseline_ids),
            "removed": len(baseline_ids - current_ids),
        },
        "canonical_delta": {
            "added": len(current_canonical - baseline_canonical),
            "removed": len(baseline_canonical - current_canonical),
        },
        "source_count_delta": source_count_delta,
        "source_revision_changes": revision_changes,
        "examples": {
            "added_ids": sorted(current_ids - baseline_ids)[:20],
            "removed_ids": sorted(baseline_ids - current_ids)[:20],
        },
    }
    return summary


def write_diff_tracking(state_dir: Path, diff_summary: dict[str, Any]) -> None:
    write_json(state_dir / "last_diff_status.json", diff_summary)
    append_jsonl(state_dir / "diff_history.jsonl", diff_summary)


def promote_manifest(
    *,
    profile: str,
    manifest_path: Path,
    promoted_root: Path,
    state_dir: Path,
) -> dict[str, Any]:
    manifest = read_json(manifest_path, {})
    if not manifest:
        raise FileNotFoundError(f"manifest not found: {manifest_path}")

    profile_root = promoted_root / profile
    promoted_paths: dict[str, str] = {}
    for key, source in (manifest.get("paths") or {}).items():
        source_path = Path(source)
        if key == "unified":
            destination = profile_root / "unified" / source_path.name
        elif key == "gpt":
            destination = profile_root / "providers" / "gpt" / source_path.name
        elif key == "banana":
            destination = profile_root / "providers" / "banana" / source_path.name
        elif key == "used_index_seed":
            destination = profile_root / "indices" / source_path.name
        else:
            destination = profile_root / source_path.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
        promoted_paths[key] = str(destination)

    promoted_manifest = {
        **manifest,
        "schema": PROMOTION_SCHEMA,
        "promoted_at_iso": now_iso(),
        "promoted_from_manifest": str(manifest_path),
        "paths": promoted_paths,
    }
    promoted_manifest_path = profile_root / "manifest.json"
    write_json(promoted_manifest_path, promoted_manifest)

    status = {
        "schema": PROMOTION_SCHEMA,
        "promoted_at_iso": promoted_manifest["promoted_at_iso"],
        "profile": profile,
        "manifest_path": str(promoted_manifest_path),
        "prompt_count": promoted_manifest.get("prompt_count"),
        "pool_fingerprint": promoted_manifest.get("pool_fingerprint"),
    }
    write_json(state_dir / "last_promote_status.json", status)
    append_jsonl(state_dir / "promotion_history.jsonl", status)
    return promoted_manifest
