import json
import tempfile
import unittest
from pathlib import Path

from prompt_factory.adapters.awesome_gpt_image_2 import load_awesome_gpt_image_2_prompts
from prompt_factory.adapters.manual_gpt_prompts import load_manual_gpt_prompts
from prompt_factory.adapters.runtime_bridge import load_runtime_bridge_prompts


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class PromptFactoryAdapterTests(unittest.TestCase):
    def test_awesome_gpt_image_2_extracts_prompt_and_upstream_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "LICENSE").write_text("MIT License\n", encoding="utf-8")
            (root / "README.md").write_text(
                "## Poster Cases\n\n"
                "### Case 7: [Neon Poster](https://example.test/case-7) (by [Alice](https://example.test/alice))\n\n"
                "**Prompt:**\n"
                "```\n"
                "Create a neon city poster with cinematic rain, luminous signage, detailed typography, and layered depth.\n"
                "```\n",
                encoding="utf-8",
            )

            records = load_awesome_gpt_image_2_prompts(root)

        self.assertEqual(len(records), 1)
        record = records[0].to_dict()
        self.assertEqual(record["source"], "awesome-gpt-image-2-prompts")
        self.assertEqual(record["upstream_author"], "Alice")
        self.assertEqual(record["upstream_license"], "MIT License")
        self.assertEqual(record["upstream_url"], "https://example.test/case-7")
        self.assertTrue(record["upstream_revision"])

    def test_manual_gpt_prompts_preserves_curated_upstream_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manual_gpt_prompts.json"
            write_json(
                path,
                {
                    "schema": "prompt-factory-manual-gpt-prompts.v1",
                    "upstream_license": "manual-curated",
                    "prompts": [
                        {
                            "source_id": "manual-example",
                            "title": "Manual Example",
                            "prompt": "A cinematic observatory poster with copper telescope, star map labels, and blue rim light.",
                            "original_author": "Curator A",
                            "upstream_revision": "manual-rev-1",
                            "upstream_created_at": "2026-04-20T00:00:00Z",
                            "upstream_url": "https://example.test/manual",
                        }
                    ],
                },
            )

            records = load_manual_gpt_prompts(path)

        record = records[0].to_dict()
        self.assertEqual(record["upstream_revision"], "manual-rev-1")
        self.assertEqual(record["upstream_author"], "Curator A")
        self.assertEqual(record["upstream_license"], "manual-curated")
        self.assertEqual(record["upstream_created_at"], "2026-04-20T00:00:00Z")
        self.assertEqual(record["upstream_url"], "https://example.test/manual")

    def test_runtime_bridge_marks_records_as_migration_bridge_with_legacy_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prompt_pool.json"
            write_json(
                path,
                {
                    "prompts": [
                        {
                            "id": "legacy-1",
                            "source": "legacy-source",
                            "source_id": "legacy-source-id",
                            "title": "Legacy Prompt",
                            "prompt": "A migration debug prompt with chrome machinery, status labels, and dramatic lighting.",
                            "upstream_revision": "legacy-rev",
                            "upstream_author": "Runtime Bot",
                            "upstream_license": "unknown",
                            "meta": {"upstream_url": "https://example.test/legacy"},
                        }
                    ]
                },
            )

            records = load_runtime_bridge_prompts(path)

        record = records[0].to_dict()
        self.assertEqual(record["metadata"]["adapter"], "runtime_bridge")
        self.assertEqual(record["metadata"]["governance_role"], "migration_control_only")
        self.assertEqual(record["upstream_revision"], "legacy-rev")
        self.assertEqual(record["upstream_author"], "Runtime Bot")
        self.assertEqual(record["upstream_license"], "unknown")
        self.assertEqual(record["upstream_url"], "https://example.test/legacy")


if __name__ == "__main__":
    unittest.main()
