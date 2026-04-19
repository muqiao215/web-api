import test from "node:test";
import assert from "node:assert/strict";

import {
  chatResponseToResponsesResponse,
  contentToString,
  parseModelMap,
  responsesInputToMessages,
  responsesRequestToChatRequest,
} from "../chat_responses_shim.mjs";

test("contentToString flattens typed parts", () => {
  assert.equal(
    contentToString([
      { type: "input_text", text: "Reply exactly:" },
      { type: "input_text", text: "OK" },
    ]),
    "Reply exactly:\nOK"
  );
});

test("parseModelMap supports JSON", () => {
  assert.deepEqual(parseModelMap('{"gpt-5.4":"chatgpt-web","deepseek-chat":"deepseek-default"}'), {
    "gpt-5.4": "chatgpt-web",
    "deepseek-chat": "deepseek-default",
  });
});

test("parseModelMap supports k=v syntax", () => {
  assert.deepEqual(parseModelMap("gpt-5.4=chatgpt-web, deepseek-chat=deepseek-default"), {
    "gpt-5.4": "chatgpt-web",
    "deepseek-chat": "deepseek-default",
  });
});

test("responsesInputToMessages preserves instructions and role content", () => {
  const messages = responsesInputToMessages({
    instructions: "Be terse.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "Reply exactly: OK" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Prior turn" }] },
    ],
  });

  assert.deepEqual(messages, [
    { role: "system", content: "Be terse." },
    { role: "user", content: "Reply exactly: OK" },
    { role: "assistant", content: "Prior turn" },
  ]);
});

test("responsesRequestToChatRequest applies model mapping", () => {
  const result = responsesRequestToChatRequest(
    { model: "deepseek-chat", input: "Reply exactly: OK" },
    {
      defaultModel: "deepseek-default",
      modelMapping: { "deepseek-chat": "deepseek-default" },
    }
  );

  assert.deepEqual(result, {
    requestedModel: "deepseek-chat",
    chatBody: {
      model: "deepseek-default",
      messages: [{ role: "user", content: "Reply exactly: OK" }],
    },
  });
});

test("chatResponseToResponsesResponse wraps chat completions output", () => {
  const response = chatResponseToResponsesResponse(
    {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1776507415,
      model: "deepseek-default",
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
    "deepseek-chat",
    { defaultModel: "deepseek-default" }
  );

  assert.equal(response.object, "response");
  assert.equal(response.model, "deepseek-chat");
  assert.equal(response.output_text, "OK");
  assert.equal(response.output[0].content[0].type, "output_text");
  assert.equal(response.output[0].content[0].text, "OK");
  assert.equal(response.metadata.upstream_model, "deepseek-default");
});
