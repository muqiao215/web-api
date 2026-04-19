# gpt-web-responses

This package is the migrated home for the GPT Responses shim that adapts `gpt_web_api` to the `sub2api` OpenAI/Responses path.

Current live unit still runs from the old source path:

- `gpt-web-responses-shim.service`
- bind: `127.0.0.1:4252`
- upstream: `http://127.0.0.1:4242`

The new canonical source location is this directory. Runtime path migration should happen only after local tests and the existing `sub2api` account test still pass.

Run locally:

```bash
cd /root/.ductor/workspace/web_capability_api/shims/gpt-web-responses
node --test test/*.test.mjs
node gpt_web_responses_shim.mjs
```
