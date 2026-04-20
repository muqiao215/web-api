# catgpt-gateway

Wrapper target for [`vendor/CatGPT-Gateway`](../../vendor/CatGPT-Gateway).

Integration rule:

- treat `CatGPT-Gateway` as a single GPT-style browser worker
- do not replace the current `providers/gpt-web-api`
- if enabled later, route it as an additional upstream through `sub2api`
- because upstream CatGPT exposes `/v1/chat/completions` and `/v1/images/generations`, pair it with `shims/chat-responses/` so `sub2api` can test/use a Responses-compatible surface

Recommended chain:

```text
CatGPT-Gateway
  -> chat-responses shim
  -> sub2api account/group/key
```

That keeps it as an optional worker in the provider pool rather than making it the new control plane.
