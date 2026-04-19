import fs from "node:fs/promises";
import path from "node:path";

import { ApiError } from "../lib/api_error.mjs";

function formatMessagesForChat(messages) {
  return messages
    .filter((msg) => msg && typeof msg.content === "string" && msg.content.trim())
    .map((msg) => {
      const role = String(msg.role || "user").toUpperCase();
      return `${role}: ${msg.content.trim()}`;
    })
    .join("\n\n");
}

function latestUserMessage(messages) {
  const latest = [...messages]
    .reverse()
    .find((msg) => msg && msg.role === "user" && typeof msg.content === "string" && msg.content.trim());
  return latest?.content?.trim() || "";
}

function createConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createFileId() {
  return `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeFilename(filename) {
  return path.basename(filename || "upload.bin").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function inferMimeType(filename, fallback = "application/octet-stream") {
  const ext = path.extname(filename || "").toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
  };
  return map[ext] || fallback;
}

export function extractFileIdsFromMessages(messages) {
  const ids = [];
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content) {
      const id = part?.file_id || part?.file?.file_id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

export function createChatStateService({
  dataDir,
  uploadDir,
  conversationsPath,
  filesPath,
  sessionAffinity,
}) {
  async function readConversations() {
    try {
      return JSON.parse(await fs.readFile(conversationsPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function readFiles() {
    try {
      return JSON.parse(await fs.readFile(filesPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function writeFiles(files) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(filesPath, JSON.stringify(files, null, 2));
  }

  async function writeConversations(conversations) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(conversationsPath, JSON.stringify(conversations, null, 2));
  }

  async function storeFileRecord({ filename, mimeType, purpose = "assistants", buffer, sourcePath = null }) {
    await fs.mkdir(uploadDir, { recursive: true });
    const id = createFileId();
    const safeName = sanitizeFilename(filename);
    const destPath = path.join(uploadDir, `${id}-${safeName}`);
    if (buffer) {
      await fs.writeFile(destPath, buffer);
    } else if (sourcePath) {
      await fs.copyFile(sourcePath, destPath);
    } else {
      throw new Error("file content or path is required");
    }
    const stat = await fs.stat(destPath);
    const files = await readFiles();
    const record = {
      id,
      object: "file",
      bytes: stat.size,
      created_at: Math.floor(Date.now() / 1000),
      filename: safeName,
      purpose,
      mime_type: mimeType || inferMimeType(safeName),
      path: destPath,
    };
    files[id] = record;
    await writeFiles(files);
    return record;
  }

  async function resolveFileRecords(fileIds = []) {
    const files = await readFiles();
    return fileIds.map((fileId) => {
      const file = files[fileId];
      if (!file) throw new Error(`Unknown file_id: ${fileId}`);
      return file;
    });
  }

  async function resolveChatTarget(messages, conversationId, fileIds = [], providerMeta = {}) {
    const conversations = await readConversations();
    const affinity = conversationId ? await sessionAffinity.get(conversationId) : null;
    const existing = conversationId ? conversations[conversationId] : null;
    if (conversationId && !existing && !affinity) {
      throw new Error(`Unknown conversation_id: ${conversationId}`);
    }
    if (conversationId && affinity?.provider_id && providerMeta.providerId && affinity.provider_id !== providerMeta.providerId) {
      throw new ApiError(
        `conversation_id ${conversationId} is bound to provider ${affinity.provider_id}, not ${providerMeta.providerId}`,
        { status: 409, type: "conflict_error", code: "conversation_provider_mismatch" }
      );
    }
    const files = await resolveFileRecords(fileIds);

    const prompt = existing || affinity ? latestUserMessage(messages) : formatMessagesForChat(messages);
    if (!prompt) {
      throw new ApiError("messages must contain at least one non-empty text content", {
        status: 400,
        type: "invalid_request_error",
      });
    }

    return {
      conversations,
      affinity,
      conversationId: conversationId || createConversationId(),
      pageUrl: existing?.url || affinity?.conversation_url || "https://chatgpt.com/",
      prompt,
      files,
    };
  }

  async function storeConversation(conversations, conversationId, result, providerMeta = {}) {
    conversations[conversationId] = {
      id: conversationId,
      url: result.conversation_url,
      updated_at: new Date().toISOString(),
    };
    await writeConversations(conversations);
    await sessionAffinity.set(conversationId, {
      provider_id: providerMeta.providerId || "chatgpt-web",
      model: providerMeta.model || result.model,
      conversation_url: result.conversation_url,
      lock_key: providerMeta.lockKey || `chat:${conversationId}`,
    });
  }

  async function listConversations() {
    const conversations = await readConversations();
    return Object.values(conversations).sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || ""))
    );
  }

  async function listFiles() {
    const files = await readFiles();
    return Object.values(files).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  return {
    extractFileIdsFromMessages,
    readConversations,
    readFiles,
    storeFileRecord,
    resolveChatTarget,
    storeConversation,
    listConversations,
    listFiles,
  };
}
