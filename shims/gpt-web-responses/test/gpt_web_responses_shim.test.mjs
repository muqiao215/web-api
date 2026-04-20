import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import {
  chatResponseToResponsesResponse,
  contentToString,
  createShimHandler,
  responsesInputToMessages,
  responsesRequestToChatRequest,
} from "../gpt_web_responses_shim.mjs";

test("contentToString flattens typed content parts", () => {
  assert.equal(
    contentToString([
      { type: "input_text", text: "Reply exactly:" },
      { type: "input_text", text: "OK" },
    ]),
    "Reply exactly:\nOK"
  );
});

test("responsesRequestToChatRequest converts string input to chat messages", () => {
  assert.deepEqual(responsesRequestToChatRequest({ model: "chatgpt-web", input: "Reply exactly: OK" }), {
    model: "chatgpt-web",
    messages: [{ role: "user", content: "Reply exactly: OK" }],
  });
});

test("responsesInputToMessages preserves instructions and structured items", () => {
  const messages = responsesInputToMessages({
    instructions: "You are terse.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Reply exactly: OK" }],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Prior turn" }],
      },
    ],
  });

  assert.deepEqual(messages, [
    { role: "system", content: "You are terse." },
    { role: "user", content: "Reply exactly: OK" },
    { role: "assistant", content: "Prior turn" },
  ]);
});

test("chatResponseToResponsesResponse wraps chat completions output as responses output_text", () => {
  const response = chatResponseToResponsesResponse(
    {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1776507415,
      model: "chatgpt-web",
      conversation_id: "conv_1",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "OK",
          },
        },
      ],
      usage: null,
    },
    "chatgpt-web"
  );

  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "OK");
  assert.equal(response.output[0].role, "assistant");
  assert.equal(response.output[0].content[0].type, "output_text");
  assert.equal(response.output[0].content[0].text, "OK");
});

// ─── Phase 6: Shim HTTP handler smoke tests ─────────────────────────────────

test("createShimHandler /health returns expected shape with upstream_base_url and default_model", (t, done) => {
  // Smoke test: the /health endpoint is the primary read-only smoke entry point
  // for the gpt-web-responses shim. It must return a well-structured response
  // that control-workbench can use to determine shim status.
  const handler = createShimHandler({
    upstreamBaseUrl: "http://127.0.0.1:4242",
    defaultModel: "chatgpt-web",
  });

  const req = new http.IncomingMessage(null);
  req.method = "GET";
  req.url = "/health";
  req.headers = {};

  const res = new http.ServerResponse(req);
  // The shim's json() calls res.end(payload) directly — capture via overriding end
  res.end = function (chunk) {
    const body = chunk ? String(chunk) : "";
    const data = JSON.parse(body);
    assert.equal(data.status, "ok");
    assert.equal(data.shim, "gpt-web-responses");
    assert.equal(data.upstream_base_url, "http://127.0.0.1:4242");
    assert.equal(data.default_model, "chatgpt-web");
    done();
  };

  handler(req, res);
});

test("createShimHandler /healthz returns same shape as /health", (t, done) => {
  const handler = createShimHandler({
    upstreamBaseUrl: "http://127.0.0.1:4242",
    defaultModel: "chatgpt-web",
  });

  const req = new http.IncomingMessage(null);
  req.method = "GET";
  req.url = "/healthz";
  req.headers = {};

  const res = new http.ServerResponse(req);
  res.end = function (chunk) {
    const body = chunk ? String(chunk) : "";
    const data = JSON.parse(body);
    assert.equal(data.status, "ok");
    done();
  };

  handler(req, res);
});

test("createShimHandler /v1/chat/completions routes correctly to upstream", () => {
  // Integration smoke test: create an HTTP server that uses the shim handler,
  // point it at a real echo upstream, then make a real HTTP request through
  // the shim to verify the full request/response cycle.
  return new Promise((resolve, reject) => {
    let shimServer;
    let upstreamServer;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (shimServer) shimServer.close();
      if (upstreamServer) upstreamServer.close();
    };

    const doTest = () => {
      // Start upstream echo server first
      upstreamServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-test", object: "chat.completion",
            created: Math.floor(Date.now() / 1000), model: parsed.model || "chatgpt-web",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
            usage: null,
          }));
        });
      });

      upstreamServer.on("error", reject);

      // Start shim server on top of upstream
      upstreamServer.listen(0, "127.0.0.1", () => {
        const upstreamAddr = /** @type {import('node:net').AddressInfo} */ (upstreamServer.address());
        const upstreamUrl = `http://${upstreamAddr.address}:${upstreamAddr.port}`;

        const shimHandler = createShimHandler({ upstreamBaseUrl: upstreamUrl, defaultModel: "chatgpt-web" });
        shimServer = http.createServer(shimHandler);

        shimServer.on("error", reject);
        shimServer.listen(0, "127.0.0.1", () => {
          const shimAddr = /** @type {import('node:net').AddressInfo} */ (shimServer.address());

          const reqData = JSON.stringify({ model: "chatgpt-web", messages: [{ role: "user", content: "hello" }] });
          const clientReq = http.request({
            hostname: shimAddr.address, port: shimAddr.port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reqData) },
          }, (clientRes) => {
            let responseBody = "";
            clientRes.on("data", (c) => { responseBody += c; });
            clientRes.on("end", () => {
              try {
                assert.equal(clientRes.statusCode, 200);
                const data = JSON.parse(responseBody);
                assert.equal(data.id, "chatcmpl-test");
                assert.equal(data.object, "chat.completion");
                assert.ok(Array.isArray(data.choices));
              } catch (e) { cleanup(); reject(e); return; }
              cleanup(); resolve();
            });
          });

          clientReq.on("error", (e) => { cleanup(); reject(e); });
          clientReq.write(reqData);
          clientReq.end();
        });
      });

      setTimeout(() => { cleanup(); reject(new Error("Test timed out after 8s")); }, 8000);
    };

    doTest();
  });
});
