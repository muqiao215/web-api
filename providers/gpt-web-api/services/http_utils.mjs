import { errorBody, ApiError } from "../lib/api_error.mjs";

export async function readRawBody(req) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  return Buffer.concat(chunks);
}

export async function readJsonBody(req) {
  const raw = await readRawBody(req);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

export function parseMultipartFormData(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) {
    throw new Error("multipart boundary missing");
  }
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const next = buffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buffer.slice(start + boundary.length + 2, next - 2);
    start = next;
    if (!part.length) continue;
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString("utf8");
    const body = part.slice(headerEnd + 4);
    const headers = Object.fromEntries(
      headerText.split("\r\n").map((line) => {
        const idx = line.indexOf(":");
        return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
      })
    );
    const disposition = headers["content-disposition"] || "";
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
    parts.push({
      name: nameMatch?.[1] || "",
      filename: filenameMatch?.[1] || "",
      contentType: headers["content-type"] || "",
      data: body,
    });
  }
  return parts;
}

export function jsonError(message, status = 500, type = "server_error") {
  return errorBody(new ApiError(message, { status, type }));
}

export function toBase64(buffer) {
  return buffer.toString("base64");
}

export function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

export function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sendSseDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}
