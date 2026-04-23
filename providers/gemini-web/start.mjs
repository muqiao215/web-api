import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GEMINI_WEB_CANONICAL_LAUNCHER = "providers/gemini-web/start.mjs";
export const GEMINI_WEB_LEGACY_LAUNCHER = "providers/canvas-to-api/start.mjs";
export const GEMINI_WEB_UPSTREAM_DIR = fileURLToPath(
  new URL("./upstream/", import.meta.url)
);
export const GEMINI_WEB_CANONICAL_PORT = "7862";
export const GEMINI_WEB_LEGACY_PORT = "7861";

function resolveUpstreamDir() {
  return process.env.WCAPI_GEMINI_WEB_UPSTREAM_DIR
    ? resolve(process.env.WCAPI_GEMINI_WEB_UPSTREAM_DIR)
    : GEMINI_WEB_UPSTREAM_DIR;
}

function resolveUvCommand() {
  if (process.env.WCAPI_GEMINI_WEB_UV) return process.env.WCAPI_GEMINI_WEB_UV;
  return process.platform === "win32" ? "uv.exe" : "uv";
}

function resolveRuntimePort() {
  if (process.env.WCAPI_GEMINI_WEB_RUNTIME_PORT) {
    return String(process.env.WCAPI_GEMINI_WEB_RUNTIME_PORT);
  }
  if (process.env.WCAPI_GEMINI_WEB_LEGACY_MODE === "1") {
    return GEMINI_WEB_LEGACY_PORT;
  }
  return GEMINI_WEB_CANONICAL_PORT;
}

export async function launchGeminiWeb(argv = process.argv.slice(2)) {
  const upstreamDir = resolveUpstreamDir();
  accessSync(upstreamDir, constants.R_OK);

  const command = resolveUvCommand();
  const runtimePort = resolveRuntimePort();
  const args =
    argv.length > 0
      ? argv
      : [
          "run",
          "--project",
          upstreamDir,
          process.env.WCAPI_GEMINI_WEB_SCRIPT || "wcapi-gemini-web-runtime",
        ];

  const child = spawn(command, args, {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: "inherit",
    env: {
      ...process.env,
      WCAPI_GEMINI_WEB_CANONICAL_LAUNCHER: GEMINI_WEB_CANONICAL_LAUNCHER,
      WCAPI_GEMINI_WEB_LEGACY_LAUNCHER: GEMINI_WEB_LEGACY_LAUNCHER,
      WCAPI_GEMINI_WEB_UPSTREAM_DIR: upstreamDir,
      WCAPI_GEMINI_WEB_RUNTIME_PORT: runtimePort,
    },
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  return await new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { code, signal } = await launchGeminiWeb();
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gemini-web launcher] ${message}`);
    process.exit(1);
  }
}
