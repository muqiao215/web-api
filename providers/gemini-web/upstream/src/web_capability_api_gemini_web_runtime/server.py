from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import browser_cookie3
import uvicorn
from fastapi import FastAPI, HTTPException
from gemini_webapi import GeminiClient

CONTRACT_VERSION = "wcapi.browser_worker_runtime.v1"
PROVIDER_ID = "gemini-canvas"
PROVIDER_ID_CANONICAL = "gemini-web"
PROVIDER_ALIASES = [PROVIDER_ID, PROVIDER_ID_CANONICAL]
TRANSPORT_ID = "gemini-web-runtime"
TRANSPORT_TYPE = "cookie-auth-web-runtime"
COMPATIBILITY_PATH = "providers/canvas-to-api"
SURFACE_PATH = "providers/gemini-web"
UPSTREAM_PATH = "providers/gemini-web/upstream"

DEFAULT_HOST = os.environ.get("WCAPI_GEMINI_WEB_RUNTIME_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("WCAPI_GEMINI_WEB_RUNTIME_PORT", "7862"))
DEFAULT_CHAT_MODEL = os.environ.get("GEMINI_WEB_CHAT_MODEL", "gemini-3-flash")
DEFAULT_IMAGE_MODEL = os.environ.get("GEMINI_WEB_IMAGE_MODEL", DEFAULT_CHAT_MODEL)
MODEL_CACHE_TTL_SECONDS = int(os.environ.get("GEMINI_WEB_MODEL_CACHE_TTL_SECONDS", "300"))
REQUEST_TIMEOUT_SECONDS = int(os.environ.get("GEMINI_WEB_REQUEST_TIMEOUT_SECONDS", "20"))

DEFAULT_COOKIE_PATHS = (
    "/root/.browser-login/google-chrome-user-data/Default/Cookies",
    "/root/.ductor/state/browser-profiles/gemini-a/Default/Cookies",
    "/root/.ductor/state/browser-profiles/gemini-b/Default/Cookies",
)
GENERATED_IMAGE_ROOT = Path(
    os.environ.get("GEMINI_WEB_GENERATED_IMAGE_ROOT", "/root/.ductor/state/gemini-web/generated")
)
IMAGE_ADMISSION_STATE = "experimental"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _health_url() -> str:
    return f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/health"


def _cookie_db_candidates() -> list[Path]:
    raw = os.environ.get("GEMINI_WEB_COOKIE_DB_PATHS", "")
    candidates = [Path(item).expanduser() for item in raw.split(os.pathsep) if item.strip()]
    if candidates:
        return candidates
    return [Path(path) for path in DEFAULT_COOKIE_PATHS]


def _image_output_dir() -> Path:
    GENERATED_IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    return GENERATED_IMAGE_ROOT


def _render_content_block(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, str):
                if item.strip():
                    chunks.append(item.strip())
                continue
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type == "text":
                text = str(item.get("text", "")).strip()
                if text:
                    chunks.append(text)
            elif item_type == "image_url":
                url = item.get("image_url")
                if isinstance(url, dict):
                    url = url.get("url")
                if url:
                    chunks.append(f"[image:{url}]")
            else:
                serialized = json.dumps(item, ensure_ascii=False)
                chunks.append(f"[unsupported:{serialized}]")
        return "\n".join(chunk for chunk in chunks if chunk).strip()
    if content is None:
        return ""
    return str(content).strip()


def _image_admission_detail() -> dict[str, Any]:
    return {
        "state": IMAGE_ADMISSION_STATE,
        "degraded": True,
        "stability": "best_effort",
        "timeout_mode": "bounded",
        "operation": "images.generations",
        "route_path": "/v1/images/generations",
        "provider": PROVIDER_ID_CANONICAL,
        "provider_legacy": PROVIDER_ID,
        "max_n": 1,
        "northbound_error_codes": [
            "gemini_image_generation_timeout",
            "gemini_image_admission_degraded",
            "gemini_image_generation_failed",
        ],
    }


def _image_error_detail(message: str, *, code: str, status: int, retryable: bool = True) -> dict[str, Any]:
    return {
        "message": message,
        "type": "timeout_error" if status == 504 else "provider_error",
        "code": code,
        "status": status,
        "retryable": retryable,
        "provider": PROVIDER_ID_CANONICAL,
        "provider_legacy": PROVIDER_ID,
        "operation": "images.generations",
        "admission": IMAGE_ADMISSION_STATE,
        "admission_detail": _image_admission_detail(),
        "meta": {
            "provider": PROVIDER_ID_CANONICAL,
            "provider_legacy": PROVIDER_ID,
            "operation": "images.generations",
            "admission": IMAGE_ADMISSION_STATE,
            "degraded": True,
            "retryable": retryable,
        },
    }


def _messages_to_prompt(messages: list[dict[str, Any]]) -> str:
    rendered: list[str] = []
    for message in messages:
        role = str(message.get("role", "user")).upper()
        content = _render_content_block(message.get("content"))
        if content:
            rendered.append(f"{role}: {content}")
    return "\n\n".join(rendered).strip()


def _transport_contract() -> dict[str, Any]:
    return {
        "id": TRANSPORT_ID,
        "type": TRANSPORT_TYPE,
        "compatibility_path": COMPATIBILITY_PATH,
        "provider_surface_path": SURFACE_PATH,
        "canonical_launcher": f"{SURFACE_PATH}/start.mjs",
        "legacy_launcher": f"{COMPATIBILITY_PATH}/start.mjs",
        "canonical_runtime_status": f"{SURFACE_PATH}/runtime_status.mjs",
        "legacy_runtime_status": f"{COMPATIBILITY_PATH}/runtime_status.mjs",
        "startup_delegate_cwd": UPSTREAM_PATH,
        "live_runtime_owner": UPSTREAM_PATH,
        "health_url": _health_url(),
        "notes": "Gemini Web-first cookie runtime. Chat is primary; image admission is experimental/degraded.",
    }


class GeminiRuntime:
    def __init__(self) -> None:
        self._client: GeminiClient | None = None
        self._lock = asyncio.Lock()
        self._model_cache: list[str] = []
        self._model_cache_at = 0.0
        self.auth_source: str | None = None
        self.last_init_error: str | None = None
        self.last_init_at: str | None = None
        self.last_generate_error: str | None = None

    def _load_cookie_credentials_sync(self) -> tuple[str, str, str]:
        env_psid = os.environ.get("GEMINI_WEB_SECURE_1PSID")
        env_psidts = os.environ.get("GEMINI_WEB_SECURE_1PSIDTS")
        if env_psid and env_psidts:
            return env_psid, env_psidts, "env:GEMINI_WEB_SECURE_1PSID*"

        errors: list[str] = []
        for cookie_path in _cookie_db_candidates():
            if not cookie_path.exists():
                errors.append(f"{cookie_path}:missing")
                continue
            try:
                jar = browser_cookie3.chrome(cookie_file=str(cookie_path))
            except Exception as exc:  # pragma: no cover - defensive surface
                errors.append(f"{cookie_path}:{exc}")
                continue
            values = {cookie.name: cookie.value for cookie in jar if cookie.name in {"__Secure-1PSID", "__Secure-1PSIDTS"}}
            secure_1psid = values.get("__Secure-1PSID")
            secure_1psidts = values.get("__Secure-1PSIDTS")
            if secure_1psid and secure_1psidts:
                return secure_1psid, secure_1psidts, f"cookie-db:{cookie_path}"
            errors.append(f"{cookie_path}:missing_psid")

        raise RuntimeError("no usable Gemini cookie source found; checked " + ", ".join(errors))

    async def _build_client(self) -> GeminiClient:
        secure_1psid, secure_1psidts, auth_source = await asyncio.to_thread(self._load_cookie_credentials_sync)
        client = GeminiClient(
            secure_1psid=secure_1psid,
            secure_1psidts=secure_1psidts,
            proxy=os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy"),
        )
        await client.init(
            timeout=REQUEST_TIMEOUT_SECONDS,
            auto_close=True,
            close_delay=5,
            auto_refresh=False,
        )
        self.auth_source = auth_source
        self.last_init_error = None
        self.last_init_at = _now_iso()
        return client

    async def ensure_client(self) -> GeminiClient:
        async with self._lock:
            if self._client is not None:
                return self._client
            try:
                self._client = await self._build_client()
                return self._client
            except Exception as exc:
                self.last_init_error = str(exc)
                self._client = None
                raise

    async def close(self) -> None:
        async with self._lock:
            if self._client is None:
                return
            try:
                await self._client.close()
            finally:
                self._client = None

    async def list_models(self, *, force: bool = False) -> list[str]:
        now = time.time()
        if not force and self._model_cache and (now - self._model_cache_at) < MODEL_CACHE_TTL_SECONDS:
            return self._model_cache
        client = await self.ensure_client()
        models = client.list_models()
        model_ids = [getattr(model, "name", None) or str(model) for model in models]
        self._model_cache = model_ids
        self._model_cache_at = now
        return model_ids

    async def generate_text(self, prompt: str, *, model: str) -> tuple[str, Any]:
        client = await self.ensure_client()
        try:
            output = await asyncio.wait_for(
                client.generate_content(prompt, model=model),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            await self.close()
            raise RuntimeError("Gemini text generation timed out") from exc
        candidate = output.candidates[0] if output.candidates else None
        text = candidate.text if candidate and candidate.text else ""
        return text, candidate

    async def generate_images(self, prompt: str, *, model: str) -> list[dict[str, Any]]:
        client = await self.ensure_client()
        try:
            output = await asyncio.wait_for(
                client.generate_content(prompt, model=model),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            await self.close()
            raise RuntimeError("Gemini image generation timed out") from exc
        candidate = output.candidates[0] if output.candidates else None
        generated_images = list(candidate.generated_images if candidate else [])
        if not generated_images:
            raise RuntimeError("Gemini returned no generated_images; image admission is currently degraded")

        image_dir = _image_output_dir()
        saved: list[dict[str, Any]] = []
        for index, image in enumerate(generated_images, start=1):
            image_id = getattr(image, "image_id", "") or uuid.uuid4().hex
            file_name = f"{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{index}-{image_id}.png"
            output_path = image_dir / file_name
            await asyncio.to_thread(image.save, str(output_path))
            digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
            saved.append(
                {
                    "local_path": str(output_path),
                    "mime_type": "image/png",
                    "sha256": digest,
                    "source_url": getattr(image, "url", None),
                }
            )
        return saved

    async def health_payload(self) -> dict[str, Any]:
        status = "ok"
        service_alive = True
        blocked_by = "none"
        logged_in: bool | None = True
        model_ids: list[str] = []
        error: str | None = None

        try:
            model_ids = await self.list_models()
        except Exception as exc:
            error = str(exc)
            service_alive = False
            logged_in = False
            status = "blocked" if "cookie" in error.lower() or "psid" in error.lower() else "error"
            blocked_by = "cookie_missing" if status == "blocked" else "runtime_init"

        return {
            "contract_version": CONTRACT_VERSION,
            "provider_id": PROVIDER_ID,
            "provider_id_canonical": PROVIDER_ID_CANONICAL,
            "provider_id_legacy": PROVIDER_ID,
            "provider_family": PROVIDER_ID_CANONICAL,
            "provider_aliases": PROVIDER_ALIASES,
            "provider_type": "local-api",
            "checked_at": _now_iso(),
            "status": status,
            "service_alive": service_alive,
            "logged_in": logged_in,
            "cdp_ready": None,
            "browser_connected": None,
            "browserConnected": None,
            "blocked_by": blocked_by,
            "runtime_contract": {
                "status_schema": "https://local.web-capability-api/schemas/provider-capability.schema.json",
                "artifact_schema": "https://local.web-capability-api/schemas/artifact-record.schema.json",
                "queue_scope": "none",
            },
            "transport": _transport_contract(),
            "queue": {
                "supported": False,
                "mode": "none",
                "depth": {
                    "pending": None,
                    "running": None,
                    "completed": None,
                    "failed": None,
                },
                "leases": [],
                "lock_policy": None,
            },
            "profiles": [],
            "capabilities": {
                "chat": True,
                "images": True,
                "files": True,
                "vision": True,
            },
            "details": {
                "health_url": _health_url(),
                "auth_mode": "cookie",
                "auth_source": self.auth_source,
                "cookie_db_candidates": [str(path) for path in _cookie_db_candidates()],
                "last_init_at": self.last_init_at,
                "last_init_error": error or self.last_init_error,
                "last_generate_error": self.last_generate_error,
                "models": model_ids,
                "admission": {
                    "chat": "ok",
                    "images": IMAGE_ADMISSION_STATE,
                    "files": "ok",
                    "vision": "ok",
                },
                "admission_detail": {
                    "images": _image_admission_detail(),
                },
                "generated_image_root": str(_image_output_dir()),
            },
        }


runtime = GeminiRuntime()
app = FastAPI(title="wcapi-gemini-web-runtime", version="0.1.0")


@app.on_event("shutdown")
async def _shutdown() -> None:
    await runtime.close()


@app.get("/health")
async def health() -> dict[str, Any]:
    return await runtime.health_payload()


@app.get("/v1/models")
async def list_models() -> dict[str, Any]:
    try:
        models = await runtime.list_models()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "owned_by": PROVIDER_ID_CANONICAL,
                "provider": PROVIDER_ID,
            }
            for model_id in models
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("stream") is True:
        raise HTTPException(status_code=501, detail="streaming is not implemented for the Gemini Web runtime yet")

    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages[] is required")

    prompt = _messages_to_prompt(messages)
    if not prompt:
        raise HTTPException(status_code=400, detail="messages[] did not contain usable text content")

    model = str(payload.get("model") or DEFAULT_CHAT_MODEL)
    try:
        text, _candidate = await runtime.generate_text(prompt, model=model)
    except Exception as exc:
        runtime.last_generate_error = str(exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "provider": PROVIDER_ID_CANONICAL,
        "provider_legacy": PROVIDER_ID,
        "admission": IMAGE_ADMISSION_STATE,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": text,
                },
            }
        ],
        "usage": {
            "prompt_tokens": None,
            "completion_tokens": None,
            "total_tokens": None,
        },
    }


@app.post("/v1/images/generations")
async def image_generations(payload: dict[str, Any]) -> dict[str, Any]:
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    requested_n = int(payload.get("n") or 1)
    if requested_n != 1:
        raise HTTPException(status_code=400, detail="only n=1 is supported for the experimental Gemini image runtime")

    model = str(payload.get("model") or DEFAULT_IMAGE_MODEL)
    try:
        generated = await runtime.generate_images(prompt, model=model)
    except Exception as exc:
        runtime.last_generate_error = str(exc)
        message = str(exc)
        if "timed out" in message.lower() or "timeout" in message.lower():
            raise HTTPException(
                status_code=504,
                detail=_image_error_detail(
                    message,
                    code="gemini_image_generation_timeout",
                    status=504,
                    retryable=True,
                ),
            ) from exc
        if "no generated_images" in message.lower() or "image admission is currently degraded" in message.lower():
            raise HTTPException(
                status_code=503,
                detail=_image_error_detail(
                    message,
                    code="gemini_image_admission_degraded",
                    status=503,
                    retryable=True,
                ),
            ) from exc
        raise HTTPException(
            status_code=503,
            detail=_image_error_detail(
                message,
                code="gemini_image_generation_failed",
                status=503,
                retryable=True,
            ),
        ) from exc

    return {
        "created": int(time.time()),
        "provider": PROVIDER_ID_CANONICAL,
        "provider_legacy": PROVIDER_ID,
        "admission": IMAGE_ADMISSION_STATE,
        "admission_detail": _image_admission_detail(),
        "data": [
            {
                "local_path": item["local_path"],
                "mime_type": item["mime_type"],
                "sha256": item["sha256"],
                "revised_prompt": prompt,
                "source_url": item["source_url"],
            }
            for item in generated[:requested_n]
        ],
    }


def main() -> None:
    uvicorn.run(
        app,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        log_level=os.environ.get("WCAPI_GEMINI_WEB_RUNTIME_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
