# gpt-web-api

`gpt-web-api` exposes a small local OpenAI-style HTTP API backed by the real logged-in ChatGPT web session in the server browser profile.

This project intentionally uses browser automation instead of reverse-engineering ChatGPT private APIs. The browser profile is the identity container.

## Current API

- `GET /healthz`
- `GET /readyz`
- `GET /health`
- `GET /v1/models`
- `GET /v1/models/:model_id`
- `GET /v1/providers`
- `GET /v1/providers/:provider_id`
- `GET /admin/providers`
- `GET /admin/providers/:provider_id`
- `GET /v1/jobs`
- `GET /v1/jobs/:job_id`
- `POST /v1/research/jobs`
- `GET /v1/research/jobs/:job_id`
- `GET /v1/research/jobs/:job_id/result`
- `GET /v1/media`
- `GET /v1/conversations`
- `GET /v1/session-affinity`
- `GET /v1/files`
- `POST /v1/files`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `GET /generated/<filename>.png`

## Runtime

Defaults:

```bash
GPT_WEB_API_HOST=127.0.0.1
GPT_WEB_API_PORT=4242
GPT_WEB_API_CDP=http://127.0.0.1:9222
GPT_WEB_API_CHAT_TIMEOUT_MS=150000
GPT_WEB_API_IMAGE_TIMEOUT_MS=180000
GPT_WEB_API_RESEARCH_TIMEOUT_MS=240000
```

The server needs Node 22+. On this host use `/usr/local/bin/node`; `/usr/bin/node` is Node 18 and does not provide the required global `WebSocket`.

Start in foreground from the migrated tree:

```bash
cd /root/.ductor/workspace/web_capability_api/providers/gpt-web-api
node server.mjs
```

Current live systemd run still points at the old source tree and should remain there until migration cutover:

```bash
systemd-run --unit=gpt-web-api.service \
  --description='local ChatGPT web API via browser session' \
  --property=WorkingDirectory=/root/.ductor/workspace/gpt_web_api \
  --setenv=GPT_WEB_API_HOST=127.0.0.1 \
  --setenv=GPT_WEB_API_PORT=4242 \
  --setenv=GPT_WEB_API_CDP=http://127.0.0.1:9222 \
  /usr/local/bin/node /root/.ductor/workspace/gpt_web_api/server.mjs
```

Run tests:

```bash
cd /root/.ductor/workspace/web_capability_api/providers/gpt-web-api
node --test test/*.test.mjs
npm run check
```

## Examples

Chat:

```bash
curl -sS -X POST http://127.0.0.1:4242/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-web","messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

Continue a conversation:

```bash
curl -sS -X POST http://127.0.0.1:4242/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-web","conversation_id":"conv_xxx","messages":[{"role":"user","content":"Continue from the previous answer."}]}'
```

Stream chat:

```bash
curl -N -sS -X POST http://127.0.0.1:4242/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-web","stream":true,"messages":[{"role":"user","content":"Write one short sentence."}]}'
```

List local conversation mappings:

```bash
curl -sS http://127.0.0.1:4242/v1/conversations
```

Upload a file for vision or attachment use:

```bash
curl -sS -F 'purpose=vision' \
  -F 'file=@/path/to/image.png' \
  http://127.0.0.1:4242/v1/files
```

Use uploaded files in chat:

```bash
curl -sS -X POST http://127.0.0.1:4242/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-web","file_ids":["file_xxx"],"messages":[{"role":"user","content":"Look at the uploaded image. What do you see?"}]}'
```

Image URL:

```bash
curl -sS -X POST http://127.0.0.1:4242/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-images","prompt":"A minimal flat icon of a green triangle on white background.","n":1,"response_format":"url"}'
```

Providers:

```bash
curl -sS http://127.0.0.1:4242/v1/providers
```

Jobs:

```bash
curl -sS http://127.0.0.1:4242/v1/jobs
```

Create an async research job from URLs or inline source text:

```bash
curl -sS -X POST http://127.0.0.1:4242/v1/research/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "query":"总结这份运维变更记录的主要风险",
    "sources":[
      {
        "title":"变更记录",
        "text":"本次发布将数据库连接池从 20 提升到 200，并同时把日志级别调到 debug。回滚脚本未在生产演练，监控阈值仍沿用旧版本配置。"
      }
    ],
    "depth":"standard",
    "report_style":"briefing"
  }'
```

Fetch a research result:

```bash
curl -sS http://127.0.0.1:4242/v1/research/jobs/<job_id>/result
```

Generated media index:

```bash
curl -sS http://127.0.0.1:4242/v1/media
```

Session affinity:

```bash
curl -sS http://127.0.0.1:4242/v1/session-affinity
```

Image base64:

```bash
curl -sS -X POST http://127.0.0.1:4242/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-images","prompt":"A minimal flat icon of a yellow star on white background.","response_format":"b64_json"}'
```

## Behavior

- Requests are serialized through one in-process worker queue.
- Research is exposed as async jobs, not synchronous chat calls. `POST /v1/research/jobs` stages a `search -> read -> synthesize` pipeline, `GET /v1/research/jobs/:job_id` returns job state, and `GET /v1/research/jobs/:job_id/result` returns `202` while pending or the final `research.result` object when complete.
- Research accepts `urls[]` and inline `sources[]`, extracts source text locally, then uses the selected provider model to synthesize a source-cited Markdown report. Results include `summary_markdown`, structured `sections`, `sources`, `followup_suggestions`, and pipeline stage evidence.
- The queue now has explicit job records; image generations return a `job` object in the response body for traceability.
- Job records are persisted under `data/jobs.json`; if the server restarts mid-job, unfinished jobs are marked failed on reload instead of disappearing silently.
- The API now goes through a small provider router instead of hard-coding a single provider in every route.
- Provider metadata is exposed through `/v1/providers`; current implementation registers one `ChatGPTWebProvider`, but `/v1/models`, `/v1/models/:model_id`, `/v1/providers`, `/health`, chat, and image routes already resolve through the router.
- Provider capability and health detail is exposed through `/admin/providers` and `/admin/providers/:provider_id`; this includes model details, capability flags, CDP readiness, queue depth, session lock count, and runtime paths.
- `server.mjs` is now a thin bootstrap. Browser automation lives in `services/browser_runtime.mjs`, chat/session/file state in `services/chat_state_service.mjs` and `services/chat_service.mjs`, provider admin serialization in `services/provider_admin_service.mjs`, and HTTP routing in `routes/`.
- Generated images are indexed in `data/media.json` and exposed via `/v1/media`.
- Chat creates a fresh ChatGPT page for new conversations.
- Chat can continue an existing local `conversation_id`; the server maps it to the latest ChatGPT web conversation URL under `data/conversations.json`.
- Conversation affinity is additionally persisted under `data/session_affinity.json`, binding each local `conversation_id` to provider/model/url/lock key.
- For new conversations, incoming `messages` are formatted into one prompt. For existing conversations, the latest user message is sent to avoid duplicating client-side history.
- Existing conversations execute behind a session lock keyed by `conversation_id`, so future parallel worker expansion does not allow the same ChatGPT thread to be mutated concurrently.
- `stream: true` returns OpenAI-like SSE chunks plus `[DONE]`.
- `POST /v1/files` stages files under `uploads/` and returns local OpenAI-like `file_id` records.
- Chat accepts `file_ids` and uploads those local files into the real ChatGPT page before sending the prompt. Image files use `#upload-photos`; other files use `#upload-files`.
- Images use ChatGPT Images in the logged-in browser profile and save generated PNGs under `generated/`.
- Image `size` is currently limited to `1024x1024`.
- `n` is supported up to `4`, executed sequentially.
- `response_format` supports `url` and `b64_json`.
- Known ChatGPT web image rate limits are surfaced as API errors instead of silently hanging when possible.
- `GET /healthz` is a pure liveness probe; `GET /readyz` checks CDP/browser readiness and should be used for operational gating.

## Current Limitation

ChatGPT web image generation can return account-level rate limits such as “You're generating images too quickly”. That is not a local API bug; it is the web session refusing additional image generations. The service should return a clear error or timeout instead of pretending success.

## Non-Goal For Mainline

`ChatGPT Canvas bridge` is not the current mainline. Real Canvas preview exists, but the preview sandbox (`web-sandbox.oaiusercontent.com`) blocks localhost bridge access behind an `Allow network access?` permission gate. In the current real browser environment, repeated CDP automation did not successfully grant that permission, so no local bridge request reached the probe server. Keep Canvas as an experimental branch only; the mainline remains real ChatGPT page automation through the provider router.
