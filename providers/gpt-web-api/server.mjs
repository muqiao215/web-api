import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JobQueue } from "./lib/job_queue.mjs";
import { MediaStore } from "./lib/media_store.mjs";
import { ProviderRouter } from "./lib/provider_router.mjs";
import { SessionAffinityStore } from "./lib/session_affinity.mjs";
import { SessionLockRegistry } from "./lib/session_lock.mjs";
import { ChatGPTWebProvider } from "./providers/chatgpt_web_provider.mjs";
import { createOpenAIRouteHandler } from "./routes/openai_routes.mjs";
import { createResearchRouteHandler } from "./routes/research_routes.mjs";
import { createSystemRouteHandler } from "./routes/system_routes.mjs";
import { createBrowserRuntime } from "./services/browser_runtime.mjs";
import { createChatService } from "./services/chat_service.mjs";
import { createChatStateService } from "./services/chat_state_service.mjs";
import { sendJson } from "./services/http_utils.mjs";
import { createProviderAdminService } from "./services/provider_admin_service.mjs";
import { createResearchService } from "./services/research_service.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.GPT_WEB_API_HOST || "127.0.0.1";
const PORT = Number(process.env.GPT_WEB_API_PORT || 4242);
const CDP_HTTP = process.env.GPT_WEB_API_CDP || "http://127.0.0.1:9222";
const CHAT_PAGE_URL = "https://chatgpt.com/";
const IMAGE_PAGE_URL = "https://chatgpt.com/images/";
const DATA_DIR = path.join(__dirname, "data");
const OUTPUT_DIR = path.join(__dirname, "generated");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const CONVERSATIONS_PATH = path.join(DATA_DIR, "conversations.json");
const FILES_PATH = path.join(DATA_DIR, "files.json");
const MEDIA_PATH = path.join(DATA_DIR, "media.json");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
const SESSION_AFFINITY_PATH = path.join(DATA_DIR, "session_affinity.json");
const SUPPORTED_IMAGE_SIZE = "1024x1024";
const MAX_IMAGE_COUNT = 4;
const CHAT_TIMEOUT_MS = Number(process.env.GPT_WEB_API_CHAT_TIMEOUT_MS || 150000);
const IMAGE_TIMEOUT_MS = Number(process.env.GPT_WEB_API_IMAGE_TIMEOUT_MS || 180000);
const RESEARCH_TIMEOUT_MS = Number(process.env.GPT_WEB_API_RESEARCH_TIMEOUT_MS || 240000);
const CDP_HTTP_TIMEOUT_MS = Number(process.env.GPT_WEB_API_CDP_HTTP_TIMEOUT_MS || 15000);
const PUBLIC_BASE_URL = `http://${HOST}:${PORT}`;

function withTimeout(work, timeoutMs, label) {
  return Promise.race([
    work(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

const jobQueue = new JobQueue({ idPrefix: "gptwebjob", maxJobs: 500, persistencePath: JOBS_PATH });
const mediaStore = new MediaStore({ dataDir: DATA_DIR, publicBaseUrl: PUBLIC_BASE_URL });
const sessionAffinity = new SessionAffinityStore({ filepath: SESSION_AFFINITY_PATH });
const sessionLocks = new SessionLockRegistry();

const browserRuntime = createBrowserRuntime({
  cdpHttp: CDP_HTTP,
  chatPageUrl: CHAT_PAGE_URL,
  imagePageUrl: IMAGE_PAGE_URL,
  outputDir: OUTPUT_DIR,
  cdpHttpTimeoutMs: CDP_HTTP_TIMEOUT_MS,
  getQueueStats: () => jobQueue.stats(),
  getSessionLockCount: () => sessionLocks.size(),
});

const chatState = createChatStateService({
  dataDir: DATA_DIR,
  uploadDir: UPLOAD_DIR,
  conversationsPath: CONVERSATIONS_PATH,
  filesPath: FILES_PATH,
  sessionAffinity,
});

const chatService = createChatService({
  chatState,
  browserRuntime,
  sessionLocks,
});

const provider = new ChatGPTWebProvider({
  chatCompletion: chatService.chatCompletion,
  chatCompletionStream: chatService.chatCompletionStream,
  generateImage: chatService.generateImage,
  healthCheck: browserRuntime.inspectBrowserReadiness,
});

const providerRouter = new ProviderRouter();
providerRouter.register(provider, { isDefault: true });

const providerAdminService = createProviderAdminService({
  providerRouter,
  inspectBrowserReadiness: browserRuntime.inspectBrowserReadiness,
  inspectRuntimeStatus: browserRuntime.inspectRuntimeStatus,
  getQueueDepth: () => jobQueue.list().filter((job) => job.status === "queued" || job.status === "running").length,
  getQueueStats: () => jobQueue.stats(),
  getSessionLockCount: () => sessionLocks.size(),
  jobsPath: JOBS_PATH,
  sessionAffinityPath: SESSION_AFFINITY_PATH,
  mediaPath: MEDIA_PATH,
  outputDir: OUTPUT_DIR,
  uploadDir: UPLOAD_DIR,
  cdpHttp: CDP_HTTP,
  checkPathWritability: (p) => {
    try {
      if (!fs.existsSync(p)) return { writable: false, error: "not found" };
      const testFile = path.join(p, `.health_write_test_${Date.now()}`);
      fs.writeFileSync(testFile, "ok");
      fs.unlinkSync(testFile);
      return { writable: true };
    } catch (err) {
      return { writable: false, error: err.message };
    }
  },
});

const researchService = createResearchService({
  jobQueue,
  providerRouter,
  withTimeout,
  researchTimeoutMs: RESEARCH_TIMEOUT_MS,
});

function enqueueProviderJob(type, work, metadata = {}) {
  const job = jobQueue.enqueue(type, work, metadata);
  return {
    job,
    wait: () => jobQueue.wait(job.id),
  };
}

function serialize(work, type = "provider.operation", metadata = {}) {
  const queued = enqueueProviderJob(type, work, metadata);
  return queued.wait();
}

const handleOpenAIRoute = createOpenAIRouteHandler({
  providerRouter,
  providerAdminService,
  mediaStore,
  sessionAffinity,
  chatState,
  jobQueue,
  enqueueProviderJob,
  serialize,
  withTimeout,
  publicBaseUrl: PUBLIC_BASE_URL,
  supportedImageSize: SUPPORTED_IMAGE_SIZE,
  maxImageCount: MAX_IMAGE_COUNT,
  chatTimeoutMs: CHAT_TIMEOUT_MS,
  imageTimeoutMs: IMAGE_TIMEOUT_MS,
});

const handleSystemRoute = createSystemRouteHandler({
  providerAdminService,
  prepareImageThinkingMode: browserRuntime.prepareImageThinkingMode,
  outputDir: OUTPUT_DIR,
});

const handleResearchRoute = createResearchRouteHandler({
  researchService,
  publicBaseUrl: PUBLIC_BASE_URL,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", PUBLIC_BASE_URL);

  if (await handleResearchRoute(req, res, url)) return;
  if (await handleOpenAIRoute(req, res, url)) return;
  if (await handleSystemRoute(req, res, url)) return;

  sendJson(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ok: true, host: HOST, port: PORT, cdp: CDP_HTTP, output_dir: OUTPUT_DIR }));
});
