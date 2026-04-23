export class ApiError extends Error {
  constructor(message, { status = 500, type = "server_error", code = "", meta = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.meta = meta && typeof meta === "object" ? meta : null;
  }
}

export function normalizeApiError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  const message = String(error?.message || error || "Internal error");
  if (/Gemini image generation timed out/i.test(message)) {
    return new ApiError(message, {
      status: 504,
      type: "timeout_error",
      code: "gemini_image_generation_timeout",
      meta: {
        provider: "gemini-web",
        provider_legacy: "gemini-canvas",
        operation: "images.generations",
        admission: "experimental",
        degraded: true,
        retryable: true,
      },
    });
  }
  if (/Gemini returned no generated_images|image admission is currently degraded/i.test(message)) {
    return new ApiError(message, {
      status: 503,
      type: "provider_error",
      code: "gemini_image_admission_degraded",
      meta: {
        provider: "gemini-web",
        provider_legacy: "gemini-canvas",
        operation: "images.generations",
        admission: "experimental",
        degraded: true,
        retryable: true,
      },
    });
  }
  if (/rate limited|too quickly|rate_limit_exceeded|wait for an hour|image creation limit/i.test(message)) {
    return new ApiError(message, { status: 429, type: "rate_limit_error", code: "provider_rate_limited" });
  }
  if (/Image composer stale-state/i.test(message)) {
    return new ApiError(message, {
      status: 502,
      type: "provider_error",
      code: "browser_image_composer_stale",
      meta: {
        provider: "chatgpt-web",
        operation: "images.generations",
        retryable: true,
      },
    });
  }
  if (/Image composer inert/i.test(message)) {
    return new ApiError(message, {
      status: 502,
      type: "provider_error",
      code: "browser_image_composer_inert",
      meta: {
        provider: "chatgpt-web",
        operation: "images.generations",
        retryable: false,
      },
    });
  }
  if (/not logged in|log in|sign up|continue with google|continue with apple/i.test(message)) {
    return new ApiError(message, { status: 401, type: "authentication_error", code: "browser_auth_required" });
  }
  if (/timed out|timeout/i.test(message)) {
    return new ApiError(message, { status: 504, type: "timeout_error", code: "provider_timeout" });
  }
  if (/unknown provider|unknown model|unknown conversation_id|unknown file_id/i.test(message)) {
    return new ApiError(message, { status: 404, type: "not_found_error" });
  }
  if (/did not become ready|editor not found|send button not found|file input not found/i.test(message)) {
    return new ApiError(message, { status: 502, type: "provider_error", code: "browser_dom_changed" });
  }

  return new ApiError(message);
}

export function errorBody(error) {
  const normalized = normalizeApiError(error);
  return {
    status: normalized.status,
    body: {
      error: {
        message: normalized.message,
        type: normalized.type,
        ...(normalized.code ? { code: normalized.code } : {}),
        ...(normalized.meta ? { meta: normalized.meta } : {}),
      },
    },
  };
}
