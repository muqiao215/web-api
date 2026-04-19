import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeControlText,
  pickThinkingControlCandidate,
} from "../services/image_generation_modes.mjs";

test("pickThinkingControlCandidate prefers real thinking-like controls", () => {
  const candidate = pickThinkingControlCandidate([
    {
      text: "",
      ariaLabel: "Add files and more",
      title: "",
      testid: "composer-plus-btn",
      disabled: false,
    },
    {
      text: "Thinking",
      ariaLabel: "",
      title: "",
      testid: "",
      disabled: false,
    },
  ]);

  assert.equal(normalizeControlText(candidate), "Thinking");
});

test("pickThinkingControlCandidate ignores non-mode controls with similar structure", () => {
  const candidate = pickThinkingControlCandidate([
    {
      text: "",
      ariaLabel: "Send prompt",
      title: "",
      testid: "send-button",
      disabled: false,
    },
    {
      text: "Edit",
      ariaLabel: "Edit image",
      title: "",
      testid: "",
      disabled: false,
    },
  ]);

  assert.equal(candidate, null);
});
