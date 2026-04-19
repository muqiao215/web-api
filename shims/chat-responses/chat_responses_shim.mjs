import http from "node:http";
import { URL } from "node:url";

const DEFAULT_HOST = process.env.CHAT_RESPONSES_SHIM_HOST || "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.CHAT_RESPONSES_SHIM_PORT || "5327", 10);
const DEFAULT_UPSTREAM = process.env.CHAT_RESPONSES_UPSTREAM || "http://127.0.0.1:5317";
const DEFAULT_MODEL = process.env.CHAT_RESPONSES_DEFAULT_MODEL || "deepseek-default";
const DEFAULT_SHIM_NAME = process.env.CHAT_RESPONSES_SHIM_NAME || "chat-responses";
const DEFAULT_API_KEY = process.env.CHAT_RESPONSES_UPSTREAM_API_KEY || "";
const DEFAULT_FORCE_UPSTREAM_STREAM =
  String(process.env.CHAT_RESPONSES_FORCE_UPSTREAM_STREAM || "").toLowerCase() === "true";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function textPartToString(part) {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (typeof part.output === "string") {
    return part.output;
  }
  return "";
}

export function contentToString(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => textPartToString(part)).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    return textPartToString(content);
  }
  return "";
}

export function responsesInputToMessages(body = {}) {
  const messages = [];

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions.trim() });
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (const message of body.messages) {
      if (!message || typeof message !== "object") {
        continue;
      }
      const role = typeof message.role === "string" && message.role.trim() ? message.role.trim() : "user";
      const content = contentToString(message.content);
      if (content) {
        messages.push({ role, content });
      }
    }
    return messages;
  }

  if (typeof body.input === "string" && body.input.trim()) {
    messages.push({ role: "user", content: body.input.trim() });
    return messages;
  }

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (typeof item.role === "string" && item.role.trim()) {
        const content = contentToString(item.content);
        if (content) {
          messages.push({ role: item.role.trim(), content });
        }
        continue;
      }
      if (item.type === "function_call_output" && typeof item.output === "string" && item.output.trim()) {
        messages.push({ role: "tool", content: item.output.trim() });
        continue;
      }
      const fallback = contentToString(item.content);
      if (fallback) {
        messages.push({ role: "user", content: fallback });
      }
    }
  }

  return messages;
}

export function parseModelMap(value) {
  if (!value || typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed)
          .filter(([key, val]) => typeof key === "string" && typeof val === "string")
          .map(([key, val]) => [key.trim(), val.trim()])
          .filter(([key, val]) => key && val)
      );
    }
  } catch {
    // fall through to k=v parsing
  }

  return Object.fromEntries(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.split("=").map((part) => part.trim()))
      .filter((parts) => parts.length === 2 && parts[0] && parts[1])
  );
}

function mapModel(model, modelMapping) {
  if (typeof model !== "string" || !model.trim()) {
    return DEFAULT_MODEL;
  }
  return modelMapping[model.trim()] || model.trim();
}

export function responsesRequestToChatRequest(body = {}, { defaultModel = DEFAULT_MODEL, modelMapping = {} } = {}) {
  const requestedModel =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
  const chatBody = {
    model: mapModel(requestedModel, modelMapping),
    messages: responsesInputToMessages(body),
  };

  if (typeof body.temperature === "number") {
    chatBody.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") {
    chatBody.top_p = body.top_p;
  }
  if (typeof body.stream === "boolean") {
    chatBody.stream = body.stream;
  }

  return { requestedModel, chatBody };
}

function extractChatMessageText(chatResponse = {}) {
  const message = chatResponse?.choices?.[0]?.message || {};
  return typeof message.content === "string" ? message.content : contentToString(message.content);
}

export function chatResponseToResponsesResponse(chatResponse = {}, requestedModel, { defaultModel = DEFAULT_MODEL } = {}) {
  const text = extractChatMessageText(chatResponse);
  const created = Number.isFinite(chatResponse.created) ? chatResponse.created : Math.floor(Date.now() / 1000);
  const upstreamModel = typeof chatResponse.model === "string" && chatResponse.model.trim() ? chatResponse.model.trim() : null;
  const model =
    typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel.trim()
      : upstreamModel || defaultModel;
  const responseId =
    typeof chatResponse.id === "string" && chatResponse.id.trim()
      ? chatResponse.id.replace(/^chatcmpl-/, "resp_")
      : `resp_${created}`;
  const messageId =
    typeof chatResponse.id === "string" && chatResponse.id.trim()
      ? chatResponse.id.replace(/^chatcmpl-/, "msg_")
      : `msg_${created}`;

  return {
    id: responseId,
    object: "response",
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
          },
        ],
      },
    ],
    output_text: text,
    usage: chatResponse.usage || null,
    metadata: {
      source_object: chatResponse.object || "chat.completion",
      upstream_model: upstreamModel,
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function buildUpstreamHeaders({ apiKey = DEFAULT_API_KEY, extraHeaders = {} } = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (typeof apiKey === "string" && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

async function readTextBody(response) {
  return await response.text();
}

async function forwardJson({ upstreamBaseUrl, path, body, apiKey }) {
  const target = new URL(path, upstreamBaseUrl);
  const response = await fetch(target, {
    method: "POST",
    headers: buildUpstreamHeaders({ apiKey }),
    body: JSON.stringify(body),
  });
  const raw = await readTextBody(response);
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { response, raw, parsed };
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamUpstreamEvents(response, onEvent) {
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = line.replace(/^data:\s*/, "");
      if (!payload || payload === "[DONE]") {
        continue;
      }
      let event = null;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      await onEvent(event);
    }
  }
}

async function aggregateResponseFromStream({ upstreamBaseUrl, chatBody, requestedModel, apiKey, defaultModel }) {
  const target = new URL("/v1/chat/completions", upstreamBaseUrl);
  const response = await fetch(target, {
    method: "POST",
    headers: buildUpstreamHeaders({ apiKey }),
    body: JSON.stringify({ ...chatBody, stream: true }),
  });

  if (!response.ok) {
    const raw = await response.text();
    return { ok: false, status: response.status, headers: response.headers, raw };
  }

  let combinedText = "";
  let upstreamModel = chatBody.model;
  let finishReason = null;
  let lastChunkId = null;

  await streamUpstreamEvents(response, async (event) => {
    if (typeof event.model === "string" && event.model.trim()) {
      upstreamModel = event.model.trim();
    }
    if (typeof event.id === "string" && event.id.trim()) {
      lastChunkId = event.id.trim();
    }
    const delta = event?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      combinedText += delta;
    }
    if (event?.choices?.[0]?.finish_reason) {
      finishReason = event.choices[0].finish_reason;
    }
  });

  const fakeChatResponse = {
    id: lastChunkId || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: upstreamModel,
    choices: [
      {
        index: 0,
        finish_reason: finishReason || "stop",
        message: {
          role: "assistant",
          content: combinedText,
        },
      },
    ],
    usage: null,
  };

  return {
    ok: true,
    payload: chatResponseToResponsesResponse(fakeChatResponse, requestedModel, { defaultModel }),
  };
}

async function proxyResponsesStream({ res, upstreamBaseUrl, chatBody, requestedModel, apiKey }) {
  const target = new URL("/v1/chat/completions", upstreamBaseUrl);
  const response = await fetch(target, {
    method: "POST",
    headers: buildUpstreamHeaders({ apiKey }),
    body: JSON.stringify({ ...chatBody, stream: true }),
  });

  if (!response.ok) {
    const raw = await response.text();
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
    });
    res.end(raw);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const responseId = `resp_${Date.now()}`;
  let completed = false;

  writeSse(res, {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      model: requestedModel,
      status: "in_progress",
    },
  });

  await streamUpstreamEvents(response, async (event) => {
    const delta = event?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      writeSse(res, {
        type: "response.output_text.delta",
        item_id: `${responseId}_msg`,
        output_index: 0,
        content_index: 0,
        delta,
      });
    }
    if (event?.choices?.[0]?.finish_reason) {
      completed = true;
      writeSse(res, {
        type: "response.completed",
        response: {
          id: responseId,
          object: "response",
          model: requestedModel,
          status: "completed",
        },
      });
    }
  });

  if (!completed) {
    writeSse(res, {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        model: requestedModel,
        status: "completed",
      },
    });
  }
  res.end();
}

export function createShimHandler({
  upstreamBaseUrl = DEFAULT_UPSTREAM,
  defaultModel = DEFAULT_MODEL,
  apiKey = DEFAULT_API_KEY,
  shimName = DEFAULT_SHIM_NAME,
  modelMapping = parseModelMap(process.env.CHAT_RESPONSES_MODEL_MAP || ""),
  forceUpstreamStream = DEFAULT_FORCE_UPSTREAM_STREAM,
} = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/health" || pathname === "/healthz")) {
      json(res, 200, {
        status: "ok",
        shim: shimName,
        upstream_base_url: upstreamBaseUrl,
        default_model: defaultModel,
        force_upstream_stream: forceUpstreamStream,
        model_mapping: modelMapping,
      });
      return;
    }

    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      const upstream = await fetch(new URL("/v1/models", upstreamBaseUrl), {
        headers: buildUpstreamHeaders({ apiKey, extraHeaders: { Accept: "application/json" } }),
      });
      const raw = await upstream.text();
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      });
      res.end(raw);
      return;
    }

    if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
      try {
        const body = await readJsonBody(req);
        const requestedModel =
          typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
        body.model = mapModel(requestedModel, modelMapping);
        const { response, raw } = await forwardJson({
          upstreamBaseUrl,
          path: "/v1/chat/completions",
          body,
          apiKey,
        });
        res.writeHead(response.status, {
          "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        });
        res.end(raw);
      } catch (error) {
        json(res, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/responses")) {
      try {
        const body = await readJsonBody(req);
        const { requestedModel, chatBody } = responsesRequestToChatRequest(
          { ...body, model: body.model || defaultModel },
          { defaultModel, modelMapping }
        );
        if (body.stream === true) {
          await proxyResponsesStream({ res, upstreamBaseUrl, chatBody, requestedModel, apiKey });
          return;
        }

        if (forceUpstreamStream) {
          const aggregated = await aggregateResponseFromStream({
            upstreamBaseUrl,
            chatBody,
            requestedModel,
            apiKey,
            defaultModel,
          });
          if (!aggregated.ok) {
            res.writeHead(aggregated.status, {
              "Content-Type": aggregated.headers.get("content-type") || "application/json; charset=utf-8",
            });
            res.end(aggregated.raw);
            return;
          }
          json(res, 200, aggregated.payload);
          return;
        }

        const { response, parsed, raw } = await forwardJson({
          upstreamBaseUrl,
          path: "/v1/chat/completions",
          body: chatBody,
          apiKey,
        });
        if (!response.ok) {
          res.writeHead(response.status, {
            "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
          });
          res.end(raw);
          return;
        }
        json(res, 200, chatResponseToResponsesResponse(parsed || {}, requestedModel, { defaultModel }));
      } catch (error) {
        json(res, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    json(res, 404, { error: { message: `Not found: ${pathname}` } });
  };
}

export function startServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  upstreamBaseUrl = DEFAULT_UPSTREAM,
  defaultModel = DEFAULT_MODEL,
  apiKey = DEFAULT_API_KEY,
  shimName = DEFAULT_SHIM_NAME,
  modelMapping = parseModelMap(process.env.CHAT_RESPONSES_MODEL_MAP || ""),
  forceUpstreamStream = DEFAULT_FORCE_UPSTREAM_STREAM,
} = {}) {
  const server = http.createServer(
    createShimHandler({
      upstreamBaseUrl,
      defaultModel,
      apiKey,
      shimName,
      modelMapping,
      forceUpstreamStream,
    })
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
    .then((server) => {
      const address = server.address();
      const host = typeof address === "object" && address ? address.address : DEFAULT_HOST;
      const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
      process.stdout.write(
        `${JSON.stringify({ ok: true, shim: DEFAULT_SHIM_NAME, host, port, upstream: DEFAULT_UPSTREAM })}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
