import http from "node:http";
import { URL } from "node:url";

const DEFAULT_HOST = process.env.GPT_WEB_RESPONSES_SHIM_HOST || "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.GPT_WEB_RESPONSES_SHIM_PORT || "4252", 10);
const DEFAULT_UPSTREAM = process.env.GPT_WEB_CHAT_UPSTREAM || "http://127.0.0.1:4242";
const DEFAULT_MODEL = process.env.GPT_WEB_RESPONSES_DEFAULT_MODEL || "chatgpt-web";

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
      const role = typeof message.role === "string" && message.role.trim() ? message.role : "user";
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
          messages.push({ role: item.role, content });
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

export function responsesRequestToChatRequest(body = {}) {
  const messages = responsesInputToMessages(body);
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  const chatBody = {
    model,
    messages,
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

  return chatBody;
}

export function chatResponseToResponsesResponse(chatResponse = {}, requestedModel) {
  const message = chatResponse?.choices?.[0]?.message || {};
  const text = typeof message.content === "string" ? message.content : contentToString(message.content);
  const created = Number.isFinite(chatResponse.created) ? chatResponse.created : Math.floor(Date.now() / 1000);
  const model =
    typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel.trim()
      : typeof chatResponse.model === "string" && chatResponse.model.trim()
        ? chatResponse.model.trim()
        : DEFAULT_MODEL;
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
      upstream_model: chatResponse.model || null,
      conversation_id: chatResponse.conversation_id || null,
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

async function readTextBody(response) {
  return await response.text();
}

export async function forwardJson({ upstreamBaseUrl = DEFAULT_UPSTREAM, path, body }) {
  const target = new URL(path, upstreamBaseUrl);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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

async function proxyResponsesStream({ res, upstreamBaseUrl, chatBody, requestedModel }) {
  const target = new URL("/v1/chat/completions", upstreamBaseUrl);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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
  writeSse(res, {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      model: requestedModel,
      status: "in_progress",
    },
  });

  const decoder = new TextDecoder();
  let buffered = "";
  let completed = false;

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
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

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
    }
  }

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
} = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/health" || pathname === "/healthz")) {
      json(res, 200, {
        status: "ok",
        shim: "gpt-web-responses",
        upstream_base_url: upstreamBaseUrl,
        default_model: defaultModel,
      });
      return;
    }

    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      const upstream = await fetch(new URL("/v1/models", upstreamBaseUrl));
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
        if (typeof body.model !== "string" || !body.model.trim()) {
          body.model = defaultModel;
        }
        const { response, raw } = await forwardJson({
          upstreamBaseUrl,
          path: "/v1/chat/completions",
          body,
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
        const chatBody = responsesRequestToChatRequest({ ...body, model: body.model || defaultModel });
        const requestedModel = chatBody.model;
        if (body.stream === true) {
          await proxyResponsesStream({ res, upstreamBaseUrl, chatBody, requestedModel });
          return;
        }
        const { response, parsed, raw } = await forwardJson({
          upstreamBaseUrl,
          path: "/v1/chat/completions",
          body: chatBody,
        });
        if (!response.ok) {
          res.writeHead(response.status, {
            "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
          });
          res.end(raw);
          return;
        }
        json(res, 200, chatResponseToResponsesResponse(parsed || {}, requestedModel));
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
} = {}) {
  const server = http.createServer(createShimHandler({ upstreamBaseUrl, defaultModel }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
    .then((server) => {
      const address = server.address();
      const host = typeof address === "object" && address ? address.address : DEFAULT_HOST;
      const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
      process.stdout.write(
        `${JSON.stringify({ ok: true, shim: "gpt-web-responses", host, port, upstream: DEFAULT_UPSTREAM })}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
