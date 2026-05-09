import unittest

from prompt_factory.cli import build_parser


class PromptFactoryCliTests(unittest.TestCase):
    def test_build_defaults_to_local_repos_not_all_profiles(self) -> None:
        args = build_parser().parse_args(["build"])

        self.assertEqual(args.profile, "local_repos")

    def test_runtime_bridge_promotion_requires_explicit_force_flag(self) -> None:
        args = build_parser().parse_args(["promote", "--profile", "runtime_bridge"])
        forced = build_parser().parse_args(["promote", "--profile", "runtime_bridge", "--force-runtime-bridge-promotion"])

        self.assertFalse(args.force_runtime_bridge_promotion)
        self.assertTrue(forced.force_runtime_bridge_promotion)


if __name__ == "__main__":
    unittest.main()
