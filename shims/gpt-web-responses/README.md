# gpt-web-responses

This package is the migrated home for the GPT Responses shim that adapts `gpt_web_api` to the `sub2api` OpenAI/Responses path.

Current live unit now runs from this path:

- `gpt-web-responses-shim.service`
- bind: `127.0.0.1:4252`
- upstream: `http://127.0.0.1:4242`

The runtime cutover has already been completed after local tests and `sub2api` smoke checks passed.

Run locally:

```bash
cd shims/gpt-web-responses
node --test test/*.test.mjs
node gpt_web_responses_shim.mjs
```
