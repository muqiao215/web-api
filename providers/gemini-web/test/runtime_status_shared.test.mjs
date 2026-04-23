import assert from "node:assert/strict";
import test from "node:test";

import { getGeminiWebCanvasShareRuntimeStatus } from "../lib/runtime_status_shared.mjs";

test("Gemini runtime status reports the new Gemini Web-first transport contract", async () => {
  const payload = await getGeminiWebCanvasShareRuntimeStatus();

  assert.equal(payload.transport.id, "gemini-web-runtime");
  assert.equal(payload.transport.type, "cookie-auth-web-runtime");
  assert.equal(payload.transport.provider_surface_path, "providers/gemini-web");
  assert.equal(payload.transport.compatibility_path, "providers/canvas-to-api");
  assert.equal(payload.transport.startup_delegate_cwd, "providers/gemini-web/upstream");
  assert.equal(payload.transport.live_runtime_owner, "providers/gemini-web/upstream");
  assert.equal(payload.details.health_url, "http://127.0.0.1:7862/health");
});

test("Gemini runtime status exposes chat-first capabilities with experimental image admission", async () => {
  const payload = await getGeminiWebCanvasShareRuntimeStatus();

  assert.equal(payload.capabilities.chat, true);
  assert.equal(payload.capabilities.images, true);
  assert.equal(payload.capabilities.files, true);
  assert.equal(payload.capabilities.vision, true);
  assert.equal(payload.details.admission.chat, "ok");
  assert.equal(payload.details.admission.images, "experimental");
});
