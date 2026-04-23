process.env.WCAPI_GEMINI_WEB_LEGACY_MODE ??= "1";

import { launchGeminiWeb } from "../gemini-web/start.mjs";

const { code, signal } = await launchGeminiWeb(process.argv.slice(2));

if (signal) {
  process.kill(process.pid, signal);
} else {
  process.exit(code ?? 0);
}
