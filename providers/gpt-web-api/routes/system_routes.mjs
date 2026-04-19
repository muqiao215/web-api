import fs from "node:fs/promises";
import path from "node:path";

import { errorBody } from "../lib/api_error.mjs";
import { sendJson } from "../services/http_utils.mjs";

export function createSystemRouteHandler({
  providerAdminService,
  prepareImageThinkingMode,
  outputDir,
}) {
  return async function handleSystemRoute(req, res, url) {
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "gpt_web_api" });
      return true;
    }

    if (req.method === "GET" && pathname === "/readyz") {
      try {
        sendJson(res, 200, await providerAdminService.readiness());
      } catch (error) {
        const { body } = errorBody(error);
        sendJson(res, 503, {
          ok: false,
          service: "gpt_web_api",
          provider_count: providerAdminService.health().provider_count,
          browser: {
            ok: false,
            error: body.error.message,
          },
        });
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, providerAdminService.health());
      return true;
    }

    if (req.method === "GET" && pathname === "/admin/providers") {
      try {
        sendJson(res, 200, await providerAdminService.listProviderDetails());
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/admin/providers/")) {
      try {
        const providerId = decodeURIComponent(pathname.replace("/admin/providers/", ""));
        sendJson(res, 200, await providerAdminService.getProviderDetail(providerId));
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/admin/browser/image-thinking") {
      try {
        sendJson(res, 200, await prepareImageThinkingMode());
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/generated/")) {
      const filename = pathname.replace("/generated/", "");
      const filepath = path.join(outputDir, path.basename(filename));
      try {
        const file = await fs.readFile(filepath);
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(file);
      } catch {
        sendJson(res, 404, { error: { message: "file not found" } });
      }
      return true;
    }

    return false;
  };
}
