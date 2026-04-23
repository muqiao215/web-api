# Gemini Web Transport: canvas-share bridge

This transport document exists so the repo can say two true things at the same time:

- the provider family is **Gemini Web**
- the currently live transport is still the historical **canvas/share bridge**

## What Still Lives On The Legacy Side

- vendored upstream worker source: `../../canvas-to-api/upstream/`
- legacy compatibility wrapper: `../../canvas-to-api/`
- service and browser runtime names:
  - `canvas-to-api.service`
  - `gemini-canvas-browser@a.service`
  - `gemini-canvas-browser@b.service`
  - `gemini-canvas-novnc.service`

## What This Split Clarifies

Future Gemini-specific connectors or transports should conceptually belong under `providers/gemini-web/`, even if the repo keeps old runtime/service names around for compatibility.

This is a structure-level clarification, not a claim that the current transport has already been replaced.
