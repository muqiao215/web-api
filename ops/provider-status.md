# Provider Integration Status

This file tracks the practical integration state. Do not mark a provider as healthy unless a direct smoke and a `sub2api` smoke both pass.

## Matrix

| Provider | Local worker | Unified shim/API surface | `sub2api` state | Current status |
| --- | --- | --- | --- | --- |
| GPT web | `127.0.0.1:4242` | `127.0.0.1:4252/v1/responses` | account `id=1`, group `id=7`, key `id=1` | active and routed |
| Gemini Canvas | `127.0.0.1:7861` | native `/v1/responses` and `/v1beta/*` | account `id=2`, group `id=8`, key `id=2` | service active, browser session blocked |
| DeepSeek free | `127.0.0.1:5317` | `127.0.0.1:5327/v1/responses` | not registered as healthy | API shape aligned, content smoke failed |
| Qwen2API | target `127.0.0.1:7860` | can reuse `shims/chat-responses` after worker recovery | not registered | worker not listening |

## Fresh Evidence: 2026-04-19

GPT:

- `gpt-web-api.service` active
- `gpt-web-responses-shim.service` active
- prior smoke through `sub2api /v1/chat/completions` returned assistant content `OK`

Gemini Canvas:

- `canvas-to-api.service` active
- `GET http://127.0.0.1:7861/health` returned `status=ok`
- the same response reported `browserConnected=false`
- conclusion: API surface exists, but generation is blocked by browser profile/session/login state

DeepSeek:

- `ds-free-api-b492dedd.service` active
- `GET http://127.0.0.1:5327/health` returned `status=ok`
- `GET http://127.0.0.1:5327/v1/models` returned `deepseek-default` and `deepseek-expert`
- `POST http://127.0.0.1:5327/v1/responses` returned a Responses-shaped object but `output_text=""`
- streaming smoke returned `service overloaded`
- conclusion: protocol shim is in place, but the upstream worker did not pass content generation smoke

Qwen:

- `127.0.0.1:7860` is not listening on this host right now
- previous checks found qwen account pool empty when the worker was available
- conclusion: recover worker and account pool before registering in `sub2api`

## Rule

Registration into `sub2api` should happen only after:

1. Direct worker health passes.
2. Direct content generation returns non-empty assistant output.
3. The shim or native Responses path returns non-empty `output_text`.
4. `sub2api` account test passes.
5. Downstream `sub2api /v1/chat/completions` returns non-empty assistant output.
