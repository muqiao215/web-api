import fs from "node:fs/promises";
import path from "node:path";

import { errorBody } from "../lib/api_error.mjs";
import {
  jsonError,
  parseMultipartFormData,
  readJsonBody,
  readRawBody,
  sendJson,
  sendSse,
  sendSseDone,
  toBase64,
} from "../services/http_utils.mjs";

function parseOptionalIntegerField(body, fieldName, { min = 0 } = {}) {
  if (!Object.hasOwn(body, fieldName) || body[fieldName] === undefined || body[fieldName] === null || body[fieldName] === "") {
    return { present: false, value: null, error: null };
  }
  const value = Number(body[fieldName]);
  if (!Number.isInteger(value) || value < min) {
    return {
      present: true,
      value: null,
      error: jsonError(`${fieldName} must be an integer${min > 0 ? ` >= ${min}` : " >= 0"}`, 400, "invalid_request_error"),
    };
  }
  return { present: true, value, error: null };
}

export function createOpenAIRouteHandler({
  providerRouter,
  providerAdminService,
  centerJobService = null,
  mediaStore,
  sessionAffinity,
  chatState,
  jobQueue,
  enqueueProviderJob,
  serialize,
  withTimeout,
  publicBaseUrl,
  supportedImageSize,
  maxImageCount,
  chatTimeoutMs,
  imageTimeoutMs,
}) {
  function resolveImageGenerationRequest(body = {}) {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const n = Number(body.n || 1);
    const size = body.size || supportedImageSize;
    const responseFormat = body.response_format || "url";
    const selectedProvider = providerRouter.resolveProvider({
      providerId: typeof body.provider === "string" ? body.provider.trim() : "",
      modelId: typeof body.model === "string" ? body.model.trim() : "",
    });
    const selectedModel =
      body.model ||
      (typeof selectedProvider.defaultImageModel === "function"
        ? selectedProvider.defaultImageModel()
        : selectedProvider.models()[0]?.id) ||
      selectedProvider.id;
    const settleDelayMs = parseOptionalIntegerField(body, "settle_delay_ms", { min: 0 });
    const maxComposerRetries = parseOptionalIntegerField(body, "max_composer_retries", { min: 0 });
    const imageResultTimeoutMs = parseOptionalIntegerField(body, "image_result_timeout_ms", { min: 1 });

    return {
      prompt,
      n,
      size,
      responseFormat,
      selectedProvider,
      selectedModel,
      settleDelayMs,
      maxComposerRetries,
      imageResultTimeoutMs,
      imageRuntimeOptions: {
        ...(settleDelayMs.present ? { settleDelayMs: settleDelayMs.value } : {}),
        ...(maxComposerRetries.present ? { maxComposerRetries: maxComposerRetries.value } : {}),
        ...(imageResultTimeoutMs.present ? { imageResultTimeoutMs: imageResultTimeoutMs.value } : {}),
      },
    };
  }

  function validateImageGenerationRequest(request, res) {
    for (const parsed of [request.settleDelayMs, request.maxComposerRetries, request.imageResultTimeoutMs]) {
      if (parsed.error) {
        const { status, body: errorPayload } = parsed.error;
        sendJson(res, status, errorPayload);
        return false;
      }
    }

    if (!request.prompt) {
      const { status, body: errorPayload } = jsonError("prompt is required", 400, "invalid_request_error");
      sendJson(res, status, errorPayload);
      return false;
    }
    if (!Number.isInteger(request.n) || request.n < 1 || request.n > maxImageCount) {
      const { status, body: errorPayload } = jsonError(
        `n must be an integer between 1 and ${maxImageCount}`,
        400,
        "invalid_request_error"
      );
      sendJson(res, status, errorPayload);
      return false;
    }
    if (request.size !== supportedImageSize) {
      const { status, body: errorPayload } = jsonError(
        `only size ${supportedImageSize} is currently supported`,
        400,
        "invalid_request_error"
      );
      sendJson(res, status, errorPayload);
      return false;
    }
    if (!["url", "b64_json"].includes(request.responseFormat)) {
      const { status, body: errorPayload } = jsonError(
        "response_format must be url or b64_json",
        400,
        "invalid_request_error"
      );
      sendJson(res, status, errorPayload);
      return false;
    }

    return true;
  }

  async function buildImageGenerationPayload(request, results, { jobId = "" } = {}) {
    const data = [];
    const media = [];
    for (const result of results) {
      const item = { revised_prompt: request.prompt };
      if (request.responseFormat === "url") {
        item.url = `${publicBaseUrl}/generated/${path.basename(result.output_path)}`;
      } else {
        item.b64_json = toBase64(await fs.readFile(result.output_path));
      }
      data.push(item);
      media.push(
        await mediaStore.recordGeneratedMedia({
          provider: request.selectedProvider.id,
          kind: "image",
          model: request.selectedModel,
          prompt: request.prompt,
          outputPath: result.output_path,
          sourceUrl: result.image_url,
          metadata: {
            conversation_url: result.conversation_url,
            alt: result.alt,
          },
          id: result.artifact_id || "",
          mimeType: result.mime_type || "",
          sha256: result.sha256 || "",
          width: result.width ?? null,
          height: result.height ?? null,
        })
      );
    }

    return {
      created: results[0].created,
      data,
      ...(jobId ? { job: jobQueue.get(jobId) } : {}),
      meta: {
        model: request.selectedModel,
        size: supportedImageSize,
        n: request.n,
        response_format: request.responseFormat,
        provider: request.selectedProvider.id,
        provider_admission: results[0].admission || null,
        provider_admission_detail: results[0].admission_detail || null,
        media_ids: media.map((item) => item.id),
        outputs: results.map((result) => ({
          conversation_url: result.conversation_url,
          output_path: result.output_path,
          source_image_url: result.image_url,
          alt: result.alt,
        })),
      },
    };
  }

  function enqueueImageGenerationJob(request) {
    return enqueueProviderJob(
      "images.generations",
      async () => {
        const items = [];
        for (let i = 0; i < request.n; i += 1) {
          items.push(
            await withTimeout(
              () =>
                request.selectedProvider.generateImage(request.prompt, {
                  model: request.selectedModel,
                  size: request.size,
                  responseFormat: request.responseFormat,
                  ...request.imageRuntimeOptions,
                }),
              imageTimeoutMs,
              `Image generation ${i + 1}/${request.n}`
            )
          );
        }
        return buildImageGenerationPayload(request, items);
      },
      {
        provider: request.selectedProvider.id,
        model: request.selectedModel,
        prompt: request.prompt,
        n: request.n,
        response_format: request.responseFormat,
        ...(request.settleDelayMs.present ? { settle_delay_ms: request.settleDelayMs.value } : {}),
        ...(request.maxComposerRetries.present ? { max_composer_retries: request.maxComposerRetries.value } : {}),
        ...(request.imageResultTimeoutMs.present ? { image_result_timeout_ms: request.imageResultTimeoutMs.value } : {}),
      }
    );
  }

  return async function handleOpenAIRoute(req, res, url) {
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: providerRouter
          .listModels()
          .map((model) => providerAdminService.getModel(model.id))
          .filter(Boolean),
      });
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
      const modelId = decodeURIComponent(pathname.replace("/v1/models/", ""));
      const model = providerAdminService.getModel(modelId);
      if (!model) {
        sendJson(res, 404, { error: { message: `Unknown model: ${modelId}` } });
        return true;
      }
      sendJson(res, 200, model);
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/providers") {
      sendJson(res, 200, {
        object: "list",
        data: providerRouter.listProviderDescriptors(),
      });
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/v1/providers/")) {
      try {
        const providerId = decodeURIComponent(pathname.replace("/v1/providers/", ""));
        sendJson(res, 200, await providerAdminService.getProviderDetail(providerId));
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/jobs") {
      sendJson(res, 200, {
        object: "list",
        data: jobQueue.list(),
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/jobs") {
      try {
        if (!centerJobService || typeof centerJobService.createJob !== "function") {
          sendJson(res, 501, {
            error: {
              message: "center job service is not configured",
            },
          });
          return true;
        }

        const body = await readJsonBody(req);
        const job = await centerJobService.createJob(body);
        sendJson(res, 202, job);
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/v1/jobs/")) {
      const jobId = decodeURIComponent(pathname.replace("/v1/jobs/", ""));
      const job = jobQueue.get(jobId);
      if (!job) {
        sendJson(res, 404, { error: { message: `Unknown job_id: ${jobId}` } });
      } else {
        sendJson(res, 200, job);
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/media") {
      try {
        sendJson(res, 200, {
          object: "list",
          data: await mediaStore.list(),
        });
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/conversations") {
      try {
        sendJson(res, 200, {
          object: "list",
          data: await chatState.listConversations(),
        });
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/session-affinity") {
      try {
        sendJson(res, 200, {
          object: "list",
          data: await sessionAffinity.list(),
        });
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/v1/files") {
      try {
        sendJson(res, 200, {
          object: "list",
          data: await chatState.listFiles(),
        });
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/files") {
      try {
        const contentType = req.headers["content-type"] || "";
        let record;

        if (/multipart\/form-data/i.test(contentType)) {
          const raw = await readRawBody(req);
          const parts = parseMultipartFormData(raw, contentType);
          const filePart = parts.find((part) => part.name === "file" && part.filename);
          const purpose = parts.find((part) => part.name === "purpose")?.data?.toString("utf8") || "assistants";
          if (!filePart) {
            const { status, body } = jsonError("multipart file field is required", 400, "invalid_request_error");
            sendJson(res, status, body);
            return true;
          }
          record = await chatState.storeFileRecord({
            filename: filePart.filename,
            mimeType: filePart.contentType,
            purpose,
            buffer: filePart.data,
          });
        } else {
          const body = await readJsonBody(req);
          if (typeof body.path === "string" && body.path.trim()) {
            const sourcePath = body.path.trim();
            record = await chatState.storeFileRecord({
              filename: body.filename || path.basename(sourcePath),
              mimeType: body.mime_type,
              purpose: body.purpose || "assistants",
              sourcePath,
            });
          } else if (typeof body.content_base64 === "string" && body.content_base64.trim()) {
            record = await chatState.storeFileRecord({
              filename: body.filename || "upload.bin",
              mimeType: body.mime_type,
              purpose: body.purpose || "assistants",
              buffer: Buffer.from(body.content_base64, "base64"),
            });
          } else {
            const { status, body: errorPayload } = jsonError(
              "provide multipart file upload, JSON path, or content_base64",
              400,
              "invalid_request_error"
            );
            sendJson(res, status, errorPayload);
            return true;
          }
        }

        sendJson(res, 200, record);
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      try {
        const body = await readJsonBody(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const fileIds = [
          ...(Array.isArray(body.file_ids) ? body.file_ids.filter((x) => typeof x === "string") : []),
          ...chatState.extractFileIdsFromMessages(messages),
        ];
        const selectedProvider = providerRouter.resolveProvider({
          providerId: typeof body.provider === "string" ? body.provider.trim() : "",
          modelId: typeof body.model === "string" ? body.model.trim() : "",
        });
        const selectedModel = body.model || selectedProvider.models()[0]?.id || selectedProvider.id;
        const conversationId =
          typeof body.conversation_id === "string" && body.conversation_id.trim()
            ? body.conversation_id.trim()
            : null;

        if (body.stream === true) {
          const created = Math.floor(Date.now() / 1000);
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });

          try {
            const result = await serialize(() =>
              withTimeout(
                () =>
                  selectedProvider.chatCompletionStream(
                    messages,
                    { conversationId, fileIds, providerId: selectedProvider.id, model: selectedModel },
                    (delta) => {
                      sendSse(res, {
                        id: `chatcmpl-${created}`,
                        object: "chat.completion.chunk",
                        created,
                        model: selectedModel,
                        choices: [
                          {
                            index: 0,
                            delta: { content: delta },
                            finish_reason: null,
                          },
                        ],
                      });
                    }
                  ),
                chatTimeoutMs,
                "Chat completion stream"
              ),
              "chat.completions.stream",
              { provider: selectedProvider.id, model: selectedModel, conversation_id: conversationId }
            );
            sendSse(res, {
              id: `chatcmpl-${result.created}`,
              object: "chat.completion.chunk",
              created: result.created,
              model: result.model,
              conversation_id: result.conversation_id,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
              meta: {
                conversation_url: result.conversation_url,
                streaming_strategy: result.streaming_strategy || selectedProvider.streaming_strategy || null,
                streaming_degraded: result.streaming_degraded === true,
              },
            });
            sendSseDone(res);
          } catch (error) {
            sendSse(res, errorBody(error).body);
            sendSseDone(res);
          }
          return true;
        }

        const result = await serialize(
          () =>
            withTimeout(
              () =>
                selectedProvider.chatCompletion(messages, {
                  conversationId,
                  fileIds,
                  providerId: selectedProvider.id,
                  model: selectedModel,
                }),
              chatTimeoutMs,
              "Chat completion"
            ),
          "chat.completions",
          { provider: selectedProvider.id, model: selectedModel, conversation_id: conversationId }
        );
        sendJson(res, 200, {
          id: `chatcmpl-${result.created}`,
          object: "chat.completion",
          created: result.created,
          model: result.model,
          conversation_id: result.conversation_id,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: result.content,
              },
            },
          ],
          usage: null,
          meta: {
            conversation_url: result.conversation_url,
            conversation_id: result.conversation_id,
          },
        });
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/images/generations") {
      try {
        const request = resolveImageGenerationRequest(await readJsonBody(req));
        if (!validateImageGenerationRequest(request, res)) {
          return true;
        }

        const queued = enqueueImageGenerationJob(request);
        const payload = await queued.wait();
        sendJson(res, 200, {
          ...payload,
          job: jobQueue.get(queued.job.id),
        });
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/v1/images/jobs") {
      try {
        const request = resolveImageGenerationRequest(await readJsonBody(req));
        if (!validateImageGenerationRequest(request, res)) {
          return true;
        }

        const queued = enqueueImageGenerationJob(request);
        sendJson(res, 202, queued.job);
      } catch (error) {
        const { status, body } = errorBody(error);
        sendJson(res, status, body);
      }
      return true;
    }

    return false;
  };
}
