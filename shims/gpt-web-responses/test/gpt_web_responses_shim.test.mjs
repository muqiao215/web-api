import test from "node:test";
import assert from "node:assert/strict";

import {
  chatResponseToResponsesResponse,
  contentToString,
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
