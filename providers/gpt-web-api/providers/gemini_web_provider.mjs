import { ApiError } from "../lib/api_error.mjs";
import { INTEGRATION_CLASSES, RUNTIME_TIERS } from "../services/runtime_tier_policy.mjs";

const DEFAULT_RUNTIME_BASE_URL =
  process.env.GEMINI_WEB_RUNTIME_BASE_URL || "http://127.0.0.1:7862";
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_WEB_RUNTIME_TIMEOUT_MS || 30000);

const DEFAULT_MODELS = Object.freeze([
  "gemini-3-flash",
  "gemini-3-flash-thinking",
  "gemini-3-pro",
]);
const LEGACY_PROVIDER_ID = "gemini-canvas";
const IMAGE_ROUTE_PATH = "/v1/images/generations";
const CHAT_ROUTE_PATH = "/v1/chat/completions";

function buildGeminiImageAdmissionDetail(overrides = {}) {
  return {
    state: "experimental",
    degraded: true,
    stability: "best_effort",
    timeout_mode: "bounded",
    operation: "images.generations",
    route_path: IMAGE_ROUTE_PATH,
    provider: "gemini-web",
    provider_legacy: LEGACY_PROVIDER_ID,
    max_n: 1,
    northbound_error_codes: [
      "gemini_image_generation_timeout",
      "gemini_image_admission_degraded",
      "gemini_image_generation_failed",
    ],
    ...overrides,
  };
}

function buildGeminiImageErrorMeta(overrides = {}) {
  return {
    provider: "gemini-web",
    provider_legacy: LEGACY_PROVIDER_ID,
    operation: "images.generations",
    admission: "experimental",
    degraded: true,
    retryable: true,
    ...overrides,
  };
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function extractErrorMessage(payload, fallbackStatus) {
  if (typeof payload?.detail === "string" && payload.detail.trim()) {
    return payload.detail.trim();
  }
  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
    return payload.error.message.trim();
  }
  return `Gemini runtime request failed with HTTP ${fallbackStatus}`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractStructuredRuntimeError(payload, fallbackStatus, pathname) {
  const detail =
    payload?.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
      ? payload.detail
      : payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
        ? payload.error
        : null;

  if (detail) {
    const message = firstNonEmptyString(
      detail.message,
      detail.detail,
      detail.error?.message,
      payload?.error?.message,
      payload?.detail,
    ) || `Gemini runtime request failed with HTTP ${fallbackStatus}`;
    return {
      message,
      status:
        Number.isInteger(detail.status) && detail.status >= 400
          ? detail.status
          : fallbackStatus,
      type:
        firstNonEmptyString(detail.type) ||
        (fallbackStatus >= 500 ? "provider_error" : "invalid_request_error"),
      code: firstNonEmptyString(detail.code),
      meta: detail.meta && typeof detail.meta === "object" && !Array.isArray(detail.meta) ? detail.meta : null,
    };
  }

  const message = extractErrorMessage(payload, fallbackStatus);
  if (pathname === IMAGE_ROUTE_PATH) {
    if (/timed out|timeout/i.test(message)) {
      return {
        message,
        status: 504,
        type: "timeout_error",
        code: "gemini_image_generation_timeout",
        meta: buildGeminiImageErrorMeta(),
      };
    }
    if (/no generated_images|image admission is currently degraded/i.test(message)) {
      return {
        message,
        status: 503,
        type: "provider_error",
        code: "gemini_image_admission_degraded",
        meta: buildGeminiImageErrorMeta(),
      };
    }
    return {
      message,
      status: fallbackStatus,
      type: fallbackStatus >= 500 ? "provider_error" : "invalid_request_error",
      code: fallbackStatus >= 500 ? "gemini_image_generation_failed" : "",
      meta: fallbackStatus >= 500 ? buildGeminiImageErrorMeta({ retryable: fallbackStatus >= 500 }) : null,
    };
  }

  return {
    message,
    status: fallbackStatus,
    type: fallbackStatus >= 500 ? "provider_error" : "invalid_request_error",
    code: "",
    meta: null,
  };
}

export class GeminiWebProvider {
  id = "gemini-web";
  aliases = [LEGACY_PROVIDER_ID];
  name = "Gemini Web";
  type = "local-api";
  streaming_strategy = "single_event_degraded";
  runtime_tier = RUNTIME_TIERS.BROWSER_CAPABILITY;
  integration_class = INTEGRATION_CLASSES.EXTERNAL_WORKER_SHIM;
  capabilities = {
    chat: true,
    streaming: false,
    images: true,
    files: true,
    vision: true,
    image_edits: false,
  };

  constructor({
    runtimeBaseUrl = DEFAULT_RUNTIME_BASE_URL,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    models = DEFAULT_MODELS,
  } = {}) {
    this.runtimeBaseUrl = trimTrailingSlash(runtimeBaseUrl);
    this.requestTimeoutMs = requestTimeoutMs;
    this.modelIds = [...new Set(models.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  models() {
    return this.modelIds.map((modelId) => ({
      id: modelId,
      object: "model",
      owned_by: "google-web",
      provider: this.id,
    }));
  }

  defaultImageModel() {
    return this.modelIds[0] || "gemini-3-flash";
  }

  descriptor() {
    return {
      id: this.id,
      object: "provider",
      name: this.name,
      type: this.type,
      runtime_tier: this.runtime_tier,
      integration_class: this.integration_class,
      capabilities: this.capabilities,
      models: this.models().map((model) => model.id),
      aliases: this.aliases,
      streaming_strategy: this.streaming_strategy,
      admission: {
        chat: {
          state: "experimental",
          degraded: false,
          route_path: CHAT_ROUTE_PATH,
        },
        images: buildGeminiImageAdmissionDetail(),
      },
      route_meta: {
        "images.generations": buildGeminiImageAdmissionDetail(),
      },
    };
  }

  async chatCompletion(messages, options = {}) {
    const payload = await this.#requestJson("/v1/chat/completions", {
      method: "POST",
      body: {
        model: options.model || this.modelIds[0] || this.id,
        messages,
      },
    });

    const content = payload?.choices?.[0]?.message?.content;
    return {
      created: payload.created ?? Math.floor(Date.now() / 1000),
      model: payload.model || options.model || this.modelIds[0] || this.id,
      content: typeof content === "string" ? content : "",
      conversation_id: null,
      conversation_url: null,
      provider: this.id,
      provider_legacy: LEGACY_PROVIDER_ID,
      admission: payload.admission || "experimental",
      streaming_strategy: this.streaming_strategy,
    };
  }

  async chatCompletionStream(messages, options = {}, onDelta) {
    const result = await this.chatCompletion(messages, options);
    if (typeof onDelta === "function" && result.content) {
      onDelta(result.content);
    }
    return {
      ...result,
      streaming_strategy: this.streaming_strategy,
      streaming_degraded: true,
    };
  }

  async generateImage(prompt, options = {}) {
    const payload = await this.#requestJson("/v1/images/generations", {
      method: "POST",
      body: {
        prompt,
        n: 1,
        model: options.model || this.defaultImageModel(),
      },
    });

    const item = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (!item?.local_path) {
      throw new ApiError("Gemini runtime returned no local_path for generated image", {
        status: 502,
        type: "provider_error",
        code: "gemini_image_output_missing",
      });
    }

    return {
      created: payload.created ?? Math.floor(Date.now() / 1000),
      output_path: item.local_path,
      image_url: item.source_url || null,
      artifact_id: "",
      mime_type: item.mime_type || "image/png",
      sha256: item.sha256 || "",
      alt: "",
      conversation_url: null,
      provider: this.id,
      provider_legacy: LEGACY_PROVIDER_ID,
      admission: payload.admission || "experimental",
      admission_detail:
        payload?.admission_detail && typeof payload.admission_detail === "object"
          ? payload.admission_detail
          : buildGeminiImageAdmissionDetail(),
    };
  }

  async healthCheck() {
    return this.#requestJson("/health");
  }

  async runtimeStatus() {
    return this.#requestJson("/health");
  }

  async transportDetail() {
    const runtimeStatus = await this.runtimeStatus();
    return runtimeStatus?.transport || { health_url: `${this.runtimeBaseUrl}/health` };
  }

  async #requestJson(pathname, { method = "GET", body = null } = {}) {
    let response;
    try {
      response = await fetch(`${this.runtimeBaseUrl}${pathname}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      const message = firstNonEmptyString(error?.message) || "Gemini runtime request timed out";
      const isTimeout = error?.name === "TimeoutError" || /timed out|timeout/i.test(message);
      const isImageRoute = pathname === IMAGE_ROUTE_PATH;
      throw new ApiError(message, {
        status: isTimeout ? 504 : 502,
        type: isTimeout ? "timeout_error" : "provider_error",
        code: isTimeout
          ? (isImageRoute ? "gemini_image_runtime_request_timeout" : "gemini_runtime_request_timeout")
          : (isImageRoute ? "gemini_image_runtime_request_failed" : "gemini_runtime_request_failed"),
        meta: isImageRoute
          ? buildGeminiImageErrorMeta({ retryable: true })
          : {
              provider: this.id,
              provider_legacy: LEGACY_PROVIDER_ID,
              operation: pathname === CHAT_ROUTE_PATH ? "chat.completions" : pathname,
            },
      });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const runtimeError = extractStructuredRuntimeError(payload, response.status, pathname);
      throw new ApiError(runtimeError.message, {
        status: runtimeError.status,
        type: runtimeError.type,
        code: runtimeError.code,
        meta: runtimeError.meta,
      });
    }

    return payload;
  }
}
