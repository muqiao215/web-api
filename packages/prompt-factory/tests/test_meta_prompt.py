import json
import tempfile
import unittest
from pathlib import Path

from prompt_factory.cli import main
from prompt_factory.meta_prompt import build_meta_prompt_skeleton, infer_meta_prompt_archetype


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class MetaPromptTests(unittest.TestCase):
    def test_infer_travel_poster_archetype(self) -> None:
        item = {
            "source_id": "manual-dali",
            "title": "Dali Yunnan Vintage Travel Poster",
            "prompt": "Modern pencil illustration of Vintage travel poster illustration of Dali.",
            "category_tags": ["travel", "retro-poster"],
            "platform_tags": ["travel-poster"],
        }
        self.assertEqual(infer_meta_prompt_archetype(item), "travel_poster")
        self.assertEqual(
            build_meta_prompt_skeleton(item),
            "location-led subject x focal transport/object motif x layered landmark backdrop x sky/weather/light mood x bold travel-poster palette x print texture/illustration medium x poster typography",
        )

    def test_cli_meta_prompt_updates_manual_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manual_path = Path(tmp) / "manual_gpt_prompts.json"
            write_json(
                manual_path,
                {
                    "schema": "prompt-factory-manual-gpt-prompts.v1",
                    "prompts": [
                        {
                            "source_id": "manual-tech",
                            "title": "5G Smart City Tower Bands",
                            "prompt": "Ultra-realistic cinematic futuristic 5G infrastructure visualization with holographic labels.",
                            "category_tags": ["technology", "5g", "smart-city"],
                            "platform_tags": ["infographic", "poster"],
                        }
                    ],
                },
            )

            rc = main(
                [
                    "meta-prompt",
                    "--manual-path",
                    str(manual_path),
                    "--source-id",
                    "manual-tech",
                ]
            )

            payload = json.loads(manual_path.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertEqual(
            payload["prompts"][0]["meta_prompt"],
            "hero infrastructure/system x capability taxonomy x labeled component overlays x environment context x color-coded signal language x dramatic lighting/material realism x poster composition",
        )

    def test_cli_meta_prompt_preserves_existing_inline_format(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manual_path = Path(tmp) / "manual_gpt_prompts.json"
            manual_path.write_text(
                "{\n"
                '  "schema": "prompt-factory-manual-gpt-prompts.v1",\n'
                '  "prompts": [\n'
                "    {\n"
                '      "source_id": "manual-tech",\n'
                '      "title": "5G Smart City Tower Bands",\n'
                '      "quality_tier": "high",\n'
                '      "platform_tags": ["gpt-image", "poster", "education", "infographic"],\n'
                '      "model_tags": ["gpt-image-2", "gpt-image"],\n'
                '      "category_tags": ["manual-curated", "technology", "5g", "smart-city"],\n'
                '      "prompt": "Ultra-realistic cinematic futuristic 5G infrastructure visualization with holographic labels."\n'
                "    }\n"
                "  ]\n"
                "}\n",
                encoding="utf-8",
            )

            rc = main(
                [
                    "meta-prompt",
                    "--manual-path",
                    str(manual_path),
                    "--source-id",
                    "manual-tech",
                ]
            )

            raw_text = manual_path.read_text(encoding="utf-8")
            payload = json.loads(raw_text)

        self.assertEqual(rc, 0)
        self.assertIn('"platform_tags": ["gpt-image", "poster", "education", "infographic"]', raw_text)
        self.assertIn('"model_tags": ["gpt-image-2", "gpt-image"]', raw_text)
        self.assertEqual(
            payload["prompts"][0]["meta_prompt"],
            "hero infrastructure/system x capability taxonomy x labeled component overlays x environment context x color-coded signal language x dramatic lighting/material realism x poster composition",
        )


if __name__ == "__main__":
    unittest.main()
