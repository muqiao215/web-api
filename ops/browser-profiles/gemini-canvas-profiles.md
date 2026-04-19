# Gemini Canvas Browser Profiles

This host uses persistent Chrome profiles as Gemini identity containers. Do not store Google passwords, cookies, or tokens in this repository.

## Live Services

| Unit | Purpose | Bind / Display | State Path |
| --- | --- | --- | --- |
| `gemini-canvas-xvfb.service` | Dedicated Gemini display | `:101` | none |
| `gemini-canvas-novnc.service` | Manual browser takeover | `127.0.0.1:6081` -> VNC `5902` | none |
| `gemini-canvas-browser@a.service` | Google account A browser | CDP `127.0.0.1:9231` | `/root/.ductor/state/browser-profiles/gemini-a` |
| `gemini-canvas-browser@b.service` | Google account B browser | CDP `127.0.0.1:9232` | `/root/.ductor/state/browser-profiles/gemini-b` |

Both browser windows connect to the existing CanvasToAPI worker:

```text
ws://127.0.0.1:7861/ws
```

CanvasToAPI remains:

```text
canvas-to-api.service
http://127.0.0.1:7861
```

## Operator Handoff

Start or refresh the handoff stack:

```bash
/root/bin/gemini-canvas-handoff
```

From your local machine, tunnel the noVNC port:

```bash
ssh -N -L 26081:127.0.0.1:6081 <host>
```

Open:

```text
http://127.0.0.1:26081/vnc.html?autoconnect=true&resize=remote&view_only=0
```

In each browser window:

1. Log in to a different Google account.
2. Open the Gemini Canvas share page if it is not already open.
3. Fill `Server WS Endpoint` with `ws://127.0.0.1:7861/ws`.
4. Fill `API Key` with one valid CanvasToAPI API key from the local secret store.
5. Set `Browser Identifier` to `gemini-a` or `gemini-b`.
6. Save and connect.

Do not paste the Canvas API key into repository files or chat logs.

## Status Checks

```bash
/root/bin/gemini-canvas-browsers-status
curl -fsS http://127.0.0.1:7861/health
```

Expected after login and connect:

```json
{"status":"ok","browserConnected":true}
```

## Capacity Rule

This host has about 4 GiB RAM and 3 vCPUs. Keep the steady-state Gemini profile count at two. A third profile can be used for experiments, but should not be treated as a reliable 24/7 production slot without moving to a larger host.
