import json
import tempfile
import unittest
from pathlib import Path

from prompt_factory.builder import build_prompt_pool
from prompt_factory.exporters import export_gpt_prompt_pool
from prompt_factory.inline_template import (
    extract_template_fields,
    has_inline_argument_placeholders,
    render_template,
)


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class InlineTemplateTests(unittest.TestCase):
    def test_inline_template_functions_detect_extract_and_render(self) -> None:
        prompt = (
            'Create a poster about {argument name="subject" default="[subject]"} '
            'with {argument name="lighting" default="golden hour"} and again '
            '{argument name="subject" default="[subject]"} in the foreground.'
        )

        self.assertTrue(has_inline_argument_placeholders(prompt))
        self.assertEqual(
            extract_template_fields(prompt),
            [
                {"name": "subject", "default": "[subject]"},
                {"name": "lighting", "default": "golden hour"},
            ],
        )
        self.assertEqual(
            render_template(prompt, {"subject": "a lighthouse", "lighting": "blue hour"}),
            "Create a poster about a lighthouse with blue hour and again a lighthouse in the foreground.",
        )
        self.assertEqual(
            render_template(prompt, {"subject": "a lighthouse"}),
            "Create a poster about a lighthouse with golden hour and again a lighthouse in the foreground.",
        )

    def test_builder_and_exporter_preserve_prompt_and_attach_template_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manual = root / "manual_gpt_prompts.json"
            write_json(
                manual,
                {
                    "schema": "prompt-factory-manual-gpt-prompts.v1",
                    "prompts": [
                        {
                            "source_id": "manual-template",
                            "title": "Template prompt",
                            "prompt": (
                                'Luxury poster for {argument name="city" default="Tokyo"} at '
                                '{argument name="time" default="sunset"}.'
                            ),
                            "platform_tags": ["poster"],
                            "model_tags": ["gpt-image"],
                            "category_tags": ["manual-curated"],
                        }
                    ],
                },
            )
            pool = build_prompt_pool(
                {"manual_gpt": manual},
                include_sources=["manual_gpt"],
            )
            record = pool["prompts"][0]

            gpt_path = root / "builds" / "gpt" / "prompt_pool.json"
            export_gpt_prompt_pool(pool, gpt_path)
            exported = json.loads(gpt_path.read_text(encoding="utf-8"))
            exported_record = exported["prompts"][0]

        self.assertEqual(
            record["prompt"],
            'Luxury poster for {argument name="city" default="Tokyo"} at {argument name="time" default="sunset"}.',
        )
        self.assertEqual(
            record["metadata"]["template"],
            {
                "kind": "inline_argument_placeholders",
                "template_text": 'Luxury poster for {argument name="city" default="Tokyo"} at {argument name="time" default="sunset"}.',
                "fields": [
                    {"name": "city", "default": "Tokyo"},
                    {"name": "time", "default": "sunset"},
                ],
            },
        )
        self.assertEqual(exported_record["prompt"], record["prompt"])
        self.assertEqual(exported_record["meta"]["template"], record["metadata"]["template"])


if __name__ == "__main__":
    unittest.main()
