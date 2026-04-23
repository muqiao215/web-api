import http from "node:http";

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return "";
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function readSharedToken(req) {
  const authorization = req.headers.authorization;
  const bearerToken = parseBearerToken(authorization);
  if (bearerToken) return bearerToken;
  const workerToken = req.headers["x-wcapi-worker-token"];
  return typeof workerToken === "string" ? workerToken : "";
}

function supportsCapability(capabilities = [], capability = "") {
  if (!capability) return true;
  return capabilities.includes("*") || capabilities.includes(capability);
}

function buildHealthPayload({
  workerId,
  capabilities,
  runtimeTier,
  integrationClass,
  providerStyle = false,
} = {}) {
  if (providerStyle) {
    return {
      ok: true,
      object: "provider.health",
      provider_id: workerId,
      visibility: "private",
      capabilities,
      runtime_tier: runtimeTier,
      integration_class: integrationClass,
    };
  }

  return {
    ok: true,
    object: "worker.health",
    worker_id: workerId,
    visibility: "private",
    capabilities,
    runtime_tier: runtimeTier,
    integration_class: integrationClass,
  };
}

async function executeProviderChatCompletion({
  req,
  res,
  workerId,
  capabilities,
  executeJob,
} = {}) {
  const body = await readJsonBody(req);
  if (!supportsCapability(capabilities, "chat.completion")) {
    sendJson(res, 400, { error: { message: "unsupported capability: chat.completion" } });
    return;
  }

  const result = await executeJob({
    type: "chat.completion",
    capability: "chat.completion",
    payload: body,
    metadata: {
      southbound_protocol: "provider_chat_completions",
      worker_id: workerId,
    },
  });
  sendJson(res, 200, result);
}

export function createPrivateWorkerServer({
  workerId = "private-worker",
  sharedToken,
  capabilities = [],
  runtimeTier = null,
  integrationClass = null,
  executeJob,
} = {}) {
  if (!sharedToken) {
    throw new Error("sharedToken is required");
  }
  if (typeof executeJob !== "function") {
    throw new Error("executeJob must be a function");
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/internal/worker/health") {
      sendJson(
        res,
        200,
        buildHealthPayload({
          workerId,
          capabilities,
          runtimeTier,
          integrationClass,
          providerStyle: false,
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(
        res,
        200,
        buildHealthPayload({
          workerId,
          capabilities,
          runtimeTier,
          integrationClass,
          providerStyle: true,
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const token = readSharedToken(req);
      if (token !== sharedToken) {
        sendJson(res, 401, {
          error: {
            message: "unauthorized provider request",
          },
        });
        return;
      }

      try {
        await executeProviderChatCompletion({
          req,
          res,
          workerId,
          capabilities,
          executeJob,
        });
      } catch (error) {
        sendJson(res, 500, {
          error: {
            name: error.name || "Error",
            message: String(error.message || error),
          },
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/internal/worker/jobs") {
      const token = readSharedToken(req);
      if (token !== sharedToken) {
        sendJson(res, 401, {
          error: {
            message: "unauthorized worker request",
          },
        });
        return;
      }

      try {
        const job = await readJsonBody(req);
        if (!job.type || typeof job.type !== "string") {
          sendJson(res, 400, { error: { message: "type is required" } });
          return;
        }
        if (!supportsCapability(capabilities, job.capability)) {
          sendJson(res, 400, { error: { message: `unsupported capability: ${job.capability}` } });
          return;
        }

        const result = await executeJob(job);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, {
          error: {
            name: error.name || "Error",
            message: String(error.message || error),
          },
        });
      }
      return;
    }

    sendJson(res, 404, { error: { message: "not found" } });
  });
}

async function readUpstreamResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function createOpenAIChatForwarder({
  baseUrl,
  apiKey = "",
  defaultModel = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl) {
    throw new Error("baseUrl is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");

  return async function executeJob(job) {
    const payload = job?.payload && typeof job.payload === "object" ? { ...job.payload } : {};
    const body = {
      ...payload,
      model: payload.model || defaultModel,
    };

    const response = await fetchImpl(`${normalizedBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const result = await readUpstreamResponse(response);
    if (!response.ok) {
      throw new Error(result?.error?.message || `Upstream chat endpoint returned ${response.status}`);
    }
    return result;
  };
}
