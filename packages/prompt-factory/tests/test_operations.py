import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from prompt_factory.operations import (
    diff_manifest_pair,
    find_previous_manifest,
    promote_manifest,
    sync_sources,
    write_build_tracking,
)


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def run(command: list[str], cwd: Path) -> None:
    proc = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        raise AssertionError(proc.stderr or proc.stdout)


class PromptFactoryOperationsTests(unittest.TestCase):
    def test_sync_sources_fast_forwards_clean_git_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = root / "remote.git"
            seed = root / "seed"
            local = root / "local"
            state_dir = root / "state"

            run(["git", "init", "--bare", str(remote)], root)
            seed.mkdir(parents=True, exist_ok=True)
            run(["git", "init"], seed)
            run(["git", "config", "user.email", "test@example.invalid"], seed)
            run(["git", "config", "user.name", "Prompt Factory Test"], seed)
            (seed / "prompts.txt").write_text("v1\n", encoding="utf-8")
            run(["git", "add", "prompts.txt"], seed)
            run(["git", "commit", "-m", "initial"], seed)
            run(["git", "branch", "-M", "main"], seed)
            run(["git", "remote", "add", "origin", str(remote)], seed)
            run(["git", "push", "-u", "origin", "main"], seed)
            run(["git", "clone", str(remote), str(local)], root)
            run(["git", "checkout", "main"], local)

            (seed / "prompts.txt").write_text("v2\n", encoding="utf-8")
            run(["git", "add", "prompts.txt"], seed)
            run(["git", "commit", "-m", "update"], seed)
            run(["git", "push", "origin", "main"], seed)

            registry = {
                "sample": {
                    "source_id": "sample",
                    "label": "Sample",
                    "sync_mode": "git_repo",
                    "branch": "main",
                    "origin_url": str(remote),
                    "workspace_path": "local",
                    "resolved_path": str(local),
                }
            }

            summary = sync_sources(registry, state_dir=state_dir)

            self.assertEqual(summary["results"][0]["status"], "updated")
            self.assertEqual((local / "prompts.txt").read_text(encoding="utf-8"), "v2\n")
            self.assertTrue((state_dir / "source_state.json").exists())
            self.assertTrue((state_dir / "source_sync_history.jsonl").exists())

    def test_diff_manifest_pair_reports_prompt_and_revision_delta(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline_pool = {
                "prompts": [
                    {"id": "a", "canonical_id": "ca"},
                    {"id": "b", "canonical_id": "cb"},
                ]
            }
            current_pool = {
                "prompts": [
                    {"id": "b", "canonical_id": "cb"},
                    {"id": "c", "canonical_id": "cc"},
                ]
            }
            baseline_pool_path = root / "baseline" / "unified" / "prompt_pool.json"
            current_pool_path = root / "current" / "unified" / "prompt_pool.json"
            write_json(baseline_pool_path, baseline_pool)
            write_json(current_pool_path, current_pool)
            baseline_manifest_path = root / "baseline" / "manifest.json"
            current_manifest_path = root / "current" / "manifest.json"
            write_json(
                baseline_manifest_path,
                {
                    "profile": "local_repos",
                    "prompt_count": 2,
                    "source_counts": {"sample": 2},
                    "source_revision_map": {"sample": "rev1"},
                    "paths": {"unified": str(baseline_pool_path)},
                },
            )
            write_json(
                current_manifest_path,
                {
                    "profile": "local_repos",
                    "prompt_count": 2,
                    "source_counts": {"sample": 1, "other": 1},
                    "source_revision_map": {"sample": "rev2"},
                    "paths": {"unified": str(current_pool_path)},
                },
            )

            summary = diff_manifest_pair(current_manifest_path, baseline_manifest_path)

            self.assertEqual(summary["id_delta"], {"added": 1, "removed": 1})
            self.assertEqual(summary["canonical_delta"], {"added": 1, "removed": 1})
            self.assertEqual(summary["source_count_delta"]["sample"], -1)
            self.assertEqual(summary["source_revision_changes"]["sample"]["previous"], "rev1")

    def test_promote_manifest_copies_provider_exports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build = root / "builds" / "local_repos"
            promoted_root = root / "promoted"
            state_dir = root / "state"
            paths = {
                "unified": build / "unified" / "prompt_pool.json",
                "gpt": build / "providers" / "gpt" / "prompt_pool.json",
                "banana": build / "providers" / "banana" / "banana_prompts.json",
                "used_index_seed": build / "indices" / "used_prompt_ids.seed.json",
            }
            for key, path in paths.items():
                write_json(path, {"key": key})
            manifest_path = build / "manifest.json"
            write_json(
                manifest_path,
                {
                    "profile": "local_repos",
                    "prompt_count": 4,
                    "pool_fingerprint": "abc",
                    "paths": {key: str(path) for key, path in paths.items()},
                },
            )

            promoted = promote_manifest(
                profile="local_repos",
                manifest_path=manifest_path,
                promoted_root=promoted_root,
                state_dir=state_dir,
            )

            self.assertEqual(promoted["schema"], "prompt-factory-promotion.v1")
            self.assertTrue((promoted_root / "local_repos" / "manifest.json").exists())
            self.assertTrue((promoted_root / "local_repos" / "providers" / "banana" / "banana_prompts.json").exists())
            self.assertTrue((state_dir / "last_promote_status.json").exists())

    def test_build_tracking_archives_previous_manifest_and_pool(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_dir = root / "state"
            live_root = root / "builds" / "local_repos"
            live_pool = live_root / "unified" / "prompt_pool.json"
            live_manifest = live_root / "manifest.json"

            write_json(live_pool, {"prompts": [{"id": "first", "canonical_id": "c1"}]})
            first_manifest = {
                "profile": "local_repos",
                "generated_at_iso": "2026-04-20T02:00:00+0000",
                "prompt_count": 1,
                "pool_fingerprint": "fingerprint-first",
                "source_counts": {"sample": 1},
                "source_revision_map": {"sample": "rev1"},
                "paths": {"unified": str(live_pool)},
            }
            write_json(live_manifest, first_manifest)
            write_build_tracking(
                state_dir=state_dir,
                profile="local_repos",
                manifest_path=live_manifest,
                manifest=first_manifest,
            )

            write_json(live_pool, {"prompts": [{"id": "second", "canonical_id": "c2"}]})
            second_manifest = {
                "profile": "local_repos",
                "generated_at_iso": "2026-04-20T02:01:00+0000",
                "prompt_count": 1,
                "pool_fingerprint": "fingerprint-second",
                "source_counts": {"sample": 1},
                "source_revision_map": {"sample": "rev2"},
                "paths": {"unified": str(live_pool)},
            }
            write_json(live_manifest, second_manifest)
            write_build_tracking(
                state_dir=state_dir,
                profile="local_repos",
                manifest_path=live_manifest,
                manifest=second_manifest,
            )

            previous_manifest = find_previous_manifest(state_dir, "local_repos", live_manifest)
            self.assertIsNotNone(previous_manifest)
            assert previous_manifest is not None
            self.assertNotEqual(previous_manifest, live_manifest)

            summary = diff_manifest_pair(live_manifest, previous_manifest)
            self.assertEqual(summary["source_revision_changes"]["sample"]["previous"], "rev1")
            self.assertEqual(summary["source_revision_changes"]["sample"]["current"], "rev2")
            self.assertEqual(summary["id_delta"], {"added": 1, "removed": 1})


if __name__ == "__main__":
    unittest.main()
