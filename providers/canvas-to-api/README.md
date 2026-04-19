# canvas-to-api

Future target for `/root/.ductor/workspace/CanvasToAPI`.

Current live unit:

- `canvas-to-api.service`
- bind: `127.0.0.1:7861`
- current entry: `npm start` from `/root/.ductor/workspace/CanvasToAPI`

Important: service health and browser session health are different. `browserConnected=false` means the worker process is alive but Gemini/Banana generation can still fail.
