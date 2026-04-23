import { createOpenAIChatForwarder, createPrivateWorkerServer } from "./src/index.mjs";

const HOST = process.env.PRIVATE_WORKER_HOST || "127.0.0.1";
const PORT = Number(process.env.PRIVATE_WORKER_PORT || 7788);
const WORKER_ID = process.env.PRIVATE_WORKER_ID || "private-worker";
const SHARED_TOKEN = process.env.PRIVATE_WORKER_SHARED_TOKEN || "";
const OPENAI_BASE_URL = process.env.PRIVATE_WORKER_OPENAI_BASE_URL || "";
const OPENAI_API_KEY = process.env.PRIVATE_WORKER_OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.PRIVATE_WORKER_OPENAI_MODEL || "";
const RUNTIME_TIER = process.env.PRIVATE_WORKER_RUNTIME_TIER || "tier0_lightweight_text";
const INTEGRATION_CLASS = process.env.PRIVATE_WORKER_INTEGRATION_CLASS || "lightweight_text_boundary";
const CAPABILITIES = (process.env.PRIVATE_WORKER_CAPABILITIES || "chat.completion")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!SHARED_TOKEN) {
  throw new Error("PRIVATE_WORKER_SHARED_TOKEN is required");
}

if (!OPENAI_BASE_URL) {
  throw new Error("PRIVATE_WORKER_OPENAI_BASE_URL is required");
}

const server = createPrivateWorkerServer({
  workerId: WORKER_ID,
  sharedToken: SHARED_TOKEN,
  capabilities: CAPABILITIES,
  runtimeTier: RUNTIME_TIER,
  integrationClass: INTEGRATION_CLASS,
  executeJob: createOpenAIChatForwarder({
    baseUrl: OPENAI_BASE_URL,
    apiKey: OPENAI_API_KEY,
    defaultModel: OPENAI_MODEL,
  }),
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      ok: true,
      worker_id: WORKER_ID,
      host: HOST,
      port: PORT,
      capabilities: CAPABILITIES,
      runtime_tier: RUNTIME_TIER,
      integration_class: INTEGRATION_CLASS,
      upstream_base_url: OPENAI_BASE_URL,
    })
  );
});
