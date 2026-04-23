# chat-responses

`chat-responses` is a generic shim that adapts local OpenAI-style `/v1/chat/completions` workers to the Responses path that `sub2api` expects upstream.

Use it for providers that already speak chat completions but do not expose:

- `POST /v1/responses`
- `POST /responses`

Environment variables:

- `CHAT_RESPONSES_SHIM_HOST`
- `CHAT_RESPONSES_SHIM_PORT`
- `CHAT_RESPONSES_UPSTREAM`
- `CHAT_RESPONSES_UPSTREAM_API_KEY`
- `CHAT_RESPONSES_DEFAULT_MODEL`
- `CHAT_RESPONSES_MODEL_MAP`
- `CHAT_RESPONSES_FORCE_UPSTREAM_STREAM`
- `CHAT_RESPONSES_SHIM_NAME`

DeepSeek local example:

```bash
cd shims/chat-responses
node --test test/*.test.mjs

CHAT_RESPONSES_SHIM_HOST=127.0.0.1 \
CHAT_RESPONSES_SHIM_PORT=5327 \
CHAT_RESPONSES_UPSTREAM=http://127.0.0.1:5317 \
CHAT_RESPONSES_UPSTREAM_API_KEY=sk-test \
CHAT_RESPONSES_DEFAULT_MODEL=deepseek-default \
CHAT_RESPONSES_FORCE_UPSTREAM_STREAM=true \
CHAT_RESPONSES_SHIM_NAME=ds-free-responses \
node chat_responses_shim.mjs
```
