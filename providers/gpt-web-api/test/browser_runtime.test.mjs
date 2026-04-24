import assert from "node:assert/strict";
import test from "node:test";

import { __testHooks } from "../services/browser_runtime.mjs";

const { submitImagePrompt, resolveImageRuntimeOptions } = __testHooks;

class FakeImagePage {
  constructor({
    initialText = "",
    submitResults = [],
    insertLeavesDisabled = false,
    wakeEnables = true,
    keyboardEnables = true,
  } = {}) {
    this.editorText = initialText;
    this.sendDisabled = !initialText;
    this.insertLeavesDisabled = insertLeavesDisabled;
    this.wakeEnables = wakeEnables;
    this.keyboardEnables = keyboardEnables;
    this.submitResults = [...submitResults];
    this.clearCalls = 0;
    this.focusCalls = 0;
    this.wakeCalls = 0;
    this.insertCalls = [];
    this.typeTextCalls = [];
    this.clicks = 0;
  }

  async evaluate(expression) {
    if (expression.includes("image-composer-read")) {
      return {
        ok: true,
        editorText: this.editorText,
        sendDisabled: this.sendDisabled,
      };
    }

    if (expression.includes("image-composer-clear")) {
      this.clearCalls += 1;
      this.editorText = "";
      this.sendDisabled = true;
      return {
        ok: true,
        editorText: this.editorText,
        sendDisabled: this.sendDisabled,
      };
    }

    if (expression.includes("image-composer-focus")) {
      this.focusCalls += 1;
      return { ok: true };
    }

    if (expression.includes("image-composer-wake")) {
      this.wakeCalls += 1;
      if (this.editorText && this.wakeEnables) {
        this.sendDisabled = false;
      }
      return {
        ok: true,
        editorText: this.editorText,
        sendDisabled: this.sendDisabled,
      };
    }

    if (expression.includes("image-composer-submit")) {
      const next = this.submitResults.shift() || { ok: true };
      if (next.editorText !== undefined) {
        this.editorText = next.editorText;
      }
      if (next.sendDisabled !== undefined) {
        this.sendDisabled = next.sendDisabled;
      }
      if (next.ok) {
        this.clicks += 1;
        return {
          ok: true,
          editorText: this.editorText,
        };
      }
      return {
        ok: false,
        reason: next.reason || "send button still disabled",
        editorText: this.editorText,
      };
    }

    throw new Error(`Unhandled evaluate expression: ${expression.slice(0, 80)}`);
  }

  async insertText(text) {
    this.insertCalls.push(text);
    this.editorText += text;
    this.sendDisabled = this.insertLeavesDisabled;
  }

  async typeText(text) {
    this.typeTextCalls.push(text);
    this.editorText += text;
    this.sendDisabled = !this.keyboardEnables;
  }
}

test("submitImagePrompt clears stale composer and retries once for recoverable stale disable", async () => {
  const page = new FakeImagePage({
    initialText: "legacy stale prompt",
    submitResults: [
      {
        ok: false,
        reason: "send button still disabled",
        editorText: "draw a fox legacy stale prompt",
        sendDisabled: true,
      },
      {
        ok: true,
        editorText: "draw a fox",
        sendDisabled: false,
      },
    ],
  });

  const result = await submitImagePrompt(page, "draw a fox", { settleDelayMs: 0, maxComposerRetries: 1 });

  assert.equal(result.attempts, 2);
  assert.equal(result.retriedComposerStale, true);
  assert.equal(page.clearCalls, 2);
  assert.deepEqual(page.insertCalls, ["draw a fox", "draw a fox"]);
  assert.equal(page.clicks, 1);
});

test("submitImagePrompt does not retry generic disabled send without stale evidence", async () => {
  const page = new FakeImagePage({
    initialText: "",
    submitResults: [
      {
        ok: false,
        reason: "send button still disabled",
        editorText: "draw a castle",
        sendDisabled: true,
      },
    ],
  });

  await assert.rejects(
    () => submitImagePrompt(page, "draw a castle", { settleDelayMs: 0, maxComposerRetries: 1 }),
    /send button still disabled/i,
  );

  assert.equal(page.clearCalls, 1);
  assert.deepEqual(page.insertCalls, ["draw a castle"]);
  assert.equal(page.clicks, 0);
});

test("submitImagePrompt wakes image composer when CDP insertText updates DOM but leaves send disabled", async () => {
  const page = new FakeImagePage({
    initialText: "",
    insertLeavesDisabled: true,
  });

  const result = await submitImagePrompt(page, "test watercolor children book scene", {
    settleDelayMs: 0,
    maxComposerRetries: 1,
  });

  assert.equal(result.attempts, 1);
  assert.equal(page.wakeCalls, 1);
  assert.deepEqual(page.insertCalls, ["test watercolor children book scene"]);
  assert.equal(page.clicks, 1);
});

test("submitImagePrompt falls back to keyboard-like text entry when synthetic wake does not enable send", async () => {
  const page = new FakeImagePage({
    initialText: "",
    insertLeavesDisabled: true,
    wakeEnables: false,
    keyboardEnables: true,
  });

  const result = await submitImagePrompt(page, "tiny fox watercolor", {
    settleDelayMs: 0,
    maxComposerRetries: 1,
  });

  assert.equal(result.attempts, 1);
  assert.equal(page.wakeCalls, 1);
  assert.equal(page.clearCalls, 1);
  assert.deepEqual(page.insertCalls, ["tiny fox watercolor"]);
  assert.deepEqual(page.typeTextCalls, ["tiny fox watercolor"]);
  assert.equal(page.clicks, 1);
});

test("submitImagePrompt throws explicit inert composer error when all image-only fill strategies leave send disabled", async () => {
  const page = new FakeImagePage({
    initialText: "",
    insertLeavesDisabled: true,
    wakeEnables: false,
    keyboardEnables: false,
  });

  await assert.rejects(
    () => submitImagePrompt(page, "unwakeable prompt", { settleDelayMs: 0, maxComposerRetries: 1 }),
    /Image composer inert/i,
  );

  assert.equal(page.wakeCalls, 1);
  assert.equal(page.clearCalls, 1);
  assert.deepEqual(page.typeTextCalls, ["unwakeable prompt"]);
  assert.equal(page.clicks, 0);
});

test("resolveImageRuntimeOptions normalizes northbound image debug knobs", () => {
  assert.deepEqual(
    resolveImageRuntimeOptions({
      settleDelayMs: 1200,
      maxComposerRetries: 3,
      imageResultTimeoutMs: 90000,
    }),
    {
      settleDelayMs: 1200,
      maxComposerRetries: 3,
      imageResultTimeoutMs: 90000,
    },
  );

  assert.deepEqual(
    resolveImageRuntimeOptions({
      settle_delay_ms: 450,
      max_composer_retries: 2,
      image_result_timeout_ms: 60000,
    }),
    {
      settleDelayMs: 450,
      maxComposerRetries: 2,
      imageResultTimeoutMs: 60000,
    },
  );
});
