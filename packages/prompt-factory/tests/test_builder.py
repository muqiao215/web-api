import csv
import json
import tempfile
import unittest
from pathlib import Path

from prompt_factory.builder import build_prompt_pool
from prompt_factory.exporters import export_banana_prompts, export_gpt_prompt_pool


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class PromptFactoryBuildTests(unittest.TestCase):
    def make_sources(self, root: Path) -> dict[str, Path]:
        youmind = root / "ai-image-prompts-skill"
        write_json(
            youmind / "references" / "manifest.json",
            {
                "updatedAt": "2026-04-18T00:00:00Z",
                "totalPrompts": 3,
                "categories": [
                    {
                        "slug": "product-marketing",
                        "title": "Product Marketing",
                        "file": "product-marketing.json",
                        "count": 3,
                    }
                ],
            },
        )
        write_json(
            youmind / "references" / "product-marketing.json",
            [
                {
                    "id": 101,
                    "title": "Jade Tea Set",
                    "content": (
                        "Subject: a luxurious editorial still life of a jade tea set on carved stone, "
                        "surrounded by translucent citrus slices, lacquer reflections, drifting steam, "
                        "volumetric morning light, museum-grade realism, ultra detailed material study."
                    ),
                    "description": "safe still life",
                    "needReferenceImages": False,
                    "sourceMedia": ["https://example.test/sample.png"],
                },
                {
                    "id": 102,
                    "title": "Reference only",
                    "content": "Recreate the uploaded image with the same face and exact facial structure.",
                    "needReferenceImages": True,
                },
                {
                    "id": 103,
                    "title": "Human portrait",
                    "content": "A beautiful woman portrait in studio light with glossy skin and fashion hair.",
                    "needReferenceImages": False,
                },
            ],
        )

        toloka = root / "BestPrompts"
        toloka.mkdir(parents=True, exist_ok=True)
        with (toloka / "prompts.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["Prompt", "Filtered", "Type", "Orientation", "Unnamed: 6"])
            writer.writeheader()
            writer.writerow(
                {
                    "Prompt": "heaven made of fruit basket",
                    "Filtered": "",
                    "Type": "surreal-still-life",
                    "Orientation": "square",
                    "Unnamed: 6": "0.91",
                }
            )
            writer.writerow(
                {
                    "Prompt": "beautiful woman portrait, cinematic face lighting",
                    "Filtered": "",
                    "Type": "portrait",
                    "Orientation": "vertical",
                    "Unnamed: 6": "0.20",
                }
            )
        with (toloka / "uid_to_keywords.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["0"])
            writer.writeheader()
            writer.writerow({"0": "intricate, cinematic lighting, sharp focus"})
            writer.writerow({"0": "old scratched photo, dramatic shadows"})

        sd = root / "stable-diffusion-prompt-templates"
        write_json(
            sd / "images" / "landscape.yaml",
            {
                "prompt": "A vast alien botanical landscape, crystalline trees, low mist, detailed atmosphere",
                "model": "stable-diffusion",
                "sampler_name": "euler",
                "steps": 30,
                "seed": 42,
                "size": {"width": 768, "height": 512},
            },
        )

        prompt_pack = root / "prompt-pack"
        prompt_pack.mkdir(parents=True, exist_ok=True)
        (prompt_pack / "README.md").write_text(
            "# Hoppy Cat Prompt Pack\n\n"
            "Access the Google Sheets file [here](https://docs.google.com/spreadsheets/d/test-sheet-id/edit?usp=sharing).\n",
            encoding="utf-8",
        )
        with (prompt_pack / "prompt-pack.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "Colors",
                    "Object",
                    "A mix of traditional pigments used in painting as well as colors that are popular in various art forms. "
                    "Below is a list of emotions the colors might invoke when used in art.",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "Colors": "Navy Blue",
                    "Object": "Astronomers studying the night sky with a telescope inside Observatory",
                    "A mix of traditional pigments used in painting as well as colors that are popular in various art forms. "
                    "Below is a list of emotions the colors might invoke when used in art.": "Professional, trustworthy, deep",
                }
            )
            writer.writerow(
                {
                    "Colors": "Rose Gold",
                    "Object": "beautiful woman portrait in fashion studio",
                    "A mix of traditional pigments used in painting as well as colors that are popular in various art forms. "
                    "Below is a list of emotions the colors might invoke when used in art.": "luxury, intimate",
                }
            )
        awesome = root / "awesome-gpt-image-2-prompts"
        awesome.mkdir(parents=True, exist_ok=True)
        (awesome / "README.md").write_text(
            "## Portrait & Photography Cases\n\n"
            "### Case 1: [Mirror Portrait](https://example.test/portrait) (by [@portrait](https://example.test/a))\n\n"
            "**Prompt:**\n\n"
            "```\n"
            "A beautiful woman portrait in studio light with glossy skin and fashion hair.\n"
            "```\n\n"
            "## Poster & Illustration Cases\n\n"
            "### Case 2: [Retro City Poster](https://example.test/poster) (by [@poster](https://example.test/b))\n\n"
            "**Prompt:**\n\n"
            "```\n"
            "Create a cinematic retro-futurist city poster with layered typography, neon haze, intricate linework, "
            "editorial composition, atmospheric lighting, and richly detailed architecture.\n"
            "```\n",
            encoding="utf-8",
        )
        return {
            "youmind": youmind,
            "toloka": toloka,
            "stable_diffusion": sd,
            "prompt_pack": prompt_pack,
            "awesome_gpt_image_2": awesome,
        }

    def test_build_pool_filters_and_composes_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.make_sources(Path(tmp))
            pool = build_prompt_pool(
                paths,
                include_sources=[
                    "youmind",
                    "toloka",
                    "stable_diffusion",
                    "prompt_pack",
                    "awesome_gpt_image_2",
                    "atomic_composer",
                ],
                compose_keyword_limit=2,
            )

        self.assertEqual(pool["schema"], "prompt-factory-pool.v1")
        self.assertEqual(pool["prompt_count"], 7)
        self.assertEqual(pool["source_counts"]["youmind-ai-image-prompts-skill"], 1)
        self.assertEqual(pool["source_counts"]["toloka-bestprompts"], 1)
        self.assertEqual(pool["source_counts"]["stable-diffusion-prompt-templates"], 1)
        self.assertEqual(pool["source_counts"]["hoppycat-prompt-pack"], 1)
        self.assertEqual(pool["source_counts"]["awesome-gpt-image-2-prompts"], 1)
        self.assertEqual(pool["source_counts"]["atomic-composer"], 2)
        self.assertTrue(all(not item["quality"]["human_related"] for item in pool["prompts"]))
        self.assertTrue(all(not item["quality"]["requires_reference"] for item in pool["prompts"]))
        self.assertTrue(any(item["source_kind"] == "composed" for item in pool["prompts"]))
        self.assertGreater(pool["prompts"][0]["selection_score"], 0)
        self.assertTrue(any(item["source"] == "hoppycat-prompt-pack" for item in pool["prompts"]))
        self.assertTrue(any(item["source"] == "awesome-gpt-image-2-prompts" for item in pool["prompts"]))

    def test_provider_exports_are_runtime_compatible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = self.make_sources(root)
            pool = build_prompt_pool(paths, compose_keyword_limit=1)
            gpt_path = root / "builds" / "gpt" / "prompt_pool.json"
            banana_path = root / "builds" / "banana" / "banana_prompts.json"

            export_gpt_prompt_pool(pool, gpt_path)
            export_banana_prompts(pool, banana_path, max_prompts=3, min_chars=80)

            gpt = json.loads(gpt_path.read_text(encoding="utf-8"))
            banana = json.loads(banana_path.read_text(encoding="utf-8"))

        self.assertEqual(gpt["schema"], "telegram-gpt-image-prompt-pool.v1")
        self.assertEqual(gpt["prompt_count"], pool["prompt_count"])
        self.assertEqual(banana["version"], 2)
        self.assertEqual(banana["source"], "prompt_factory")
        self.assertLessEqual(banana["prompt_count"], 3)
        self.assertTrue(all({"id", "source_id", "number", "title", "prompt"} <= set(item) for item in banana["prompts"]))


if __name__ == "__main__":
    unittest.main()
