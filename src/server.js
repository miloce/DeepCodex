#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
export const DEFAULT_PORT = 1314;
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

let cachedModel = "";

loadEnv();

export function loadEnv(file = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && process.env[key] == null) process.env[key] = rest.join("=").trim();
  }
}

export function inputToMessages(input, instructions = "") {
  const messages = [];

  if (instructions) {
    messages.push({ role: "system", content: textOf(instructions) });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  const items = Array.isArray(input) ? input : input ? [input] : [];

  for (const item of items) {
    if (!item) continue;

    if (item.type === "function_call") {
      let last = messages[messages.length - 1];
      if (!last || last.role !== "assistant") {
        last = { role: "assistant", content: "", tool_calls: [] };
        messages.push(last);
      }
      last.tool_calls ??= [];
      last.tool_calls.push({
        id: item.call_id || item.id || `call_${last.tool_calls.length}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id,
        content: textOf(item.output ?? item.content ?? ""),
      });
      continue;
    }

    if (item.type === "reasoning") continue;

    const role = item.role === "developer" ? "system" : item.role || "user";
    const content = textOf(item.content ?? item.text ?? item.input ?? "");
    if (content) messages.push({ role, content });
  }

  return messages;
}

export function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value.text ?? value.value ?? "";

  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (["input_text", "output_text", "text", "reasoning_text"].includes(part?.type)) return part.text ?? "";
      return part?.text ?? "";
    })
    .join("");
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return undefined;

  const out = tools
    .map((tool) => {
      const name = tool?.function?.name || tool?.name;
      if (!name) return null;
      return {
        type: "function",
        function: {
          name,
          description: tool.function?.description || tool.description || "",
          parameters: tool.function?.parameters || tool.parameters || { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);

  return out.length ? out : undefined;
}

export function chatToResponse(chat, model) {
  const message = chat.choices?.[0]?.message || {};
  const output = [];

  if (message.content != null) {
    output.push({
      id: id("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content || "", annotations: [] }],
    });
  }

  for (const call of message.tool_calls || []) {
    output.push({
      id: id("fc"),
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function?.name || "",
      arguments: call.function?.arguments || "",
    });
  }

  if (!output.length) {
    output.push({
      id: id("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }

  return {
    id: id("resp"),
    object: "response",
    status: "completed",
    model,
    output,
    output_text: output
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join(""),
    usage: chat.usage
      ? {
          input_tokens: chat.usage.prompt_tokens || 0,
          output_tokens: chat.usage.completion_tokens || 0,
          total_tokens: chat.usage.total_tokens || 0,
        }
      : null,
  };
}

export async function chooseModel(requestedModel, apiKey) {
  const requested = String(requestedModel || "").trim();
  if (requested.startsWith("deepseek-")) return requested;
  if (cachedModel) return cachedModel;

  const models = await listDeepSeekModels(apiKey);
  const first = models.data?.find((model) => model?.id)?.id;
  if (!first) throw new Error("DeepSeek /models did not return any model id.");

  cachedModel = first;
  return first;
}

export async function listDeepSeekModels(apiKey) {
  return fetchDeepSeekJson("/models", apiKey);
}

export async function buildChatRequest(body, apiKey) {
  const model = await chooseModel(body.model, apiKey);
  const request = {
    model,
    messages: inputToMessages(body.input, body.instructions),
    stream: body.stream === true,
  };

  if (body.max_output_tokens != null) request.max_tokens = body.max_output_tokens;
  if (body.temperature != null) request.temperature = body.temperature;
  if (body.top_p != null) request.top_p = body.top_p;

  const tools = normalizeTools(body.tools);
  if (tools) request.tools = tools;
  if (body.tool_choice != null) request.tool_choice = body.tool_choice;

  return request;
}

export async function handleRequest(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const host = req.headers.host || `${HOST}:${currentPort()}`;
  const url = new URL(req.url, `http://${host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/v1")) {
    json(res, 200, {
      service: "deepcodex",
      status: "ok",
      base_url: `http://${HOST}:${currentPort()}/v1`,
      endpoint: `http://${HOST}:${currentPort()}/v1/responses`,
      models: `http://${HOST}:${currentPort()}/v1/models`,
      has_key: Boolean(apiKey),
    });
    return;
  }

  if (!apiKey) {
    json(res, 500, { error: { message: "Missing DEEPSEEK_API_KEY. Only this key is required." } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    await proxyModels(res, apiKey);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    await responses(req, res, apiKey);
    return;
  }

  json(res, 404, { error: { message: `Not found: ${url.pathname}` } });
}

async function proxyModels(res, apiKey) {
  const upstream = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
  res.end(text);
}

async function responses(req, res, apiKey) {
  let body;
  try {
    body = JSON.parse(await read(req) || "{}");
  } catch {
    json(res, 400, { error: { message: "Invalid JSON body." } });
    return;
  }

  let chatRequest;
  try {
    chatRequest = await buildChatRequest(body, apiKey);
  } catch (error) {
    json(res, 502, { error: { message: error.message } });
    return;
  }

  const upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: chatRequest.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(chatRequest),
  });

  if (!upstream.ok) {
    json(res, upstream.status >= 500 ? 502 : upstream.status, {
      error: { message: await upstream.text() },
    });
    return;
  }

  if (chatRequest.stream) {
    await streamResponse(upstream, res, chatRequest.model);
    return;
  }

  json(res, 200, chatToResponse(await upstream.json(), chatRequest.model));
}

async function streamResponse(upstream, res, model) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  await streamResponseEvents(upstream, model, (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  res.end();
}

async function streamResponseEvents(upstream, model, emit) {
  const responseId = id("resp");
  const messageId = id("msg");
  const outputItems = [];
  const toolCalls = new Map();
  let responseStarted = false;
  let textStarted = false;
  let text = "";
  let sequenceNumber = 0;

  const sendEvent = (event, data) => {
    emit(event, { ...data, sequence_number: sequenceNumber++ });
  };

  const startResponse = () => {
    if (responseStarted) return;
    responseStarted = true;
    sendEvent("response.created", { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", model, output: [] } });
  };
  const startText = () => {
    startResponse();
    if (textStarted) return;
    textStarted = true;
    outputItems.push({ type: "message", id: messageId });
    const outputIndex = outputItems.length - 1;
    sendEvent("response.output_item.added", { type: "response.output_item.added", response_id: responseId, output_index: outputIndex, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } });
    sendEvent("response.content_part.added", { type: "response.content_part.added", response_id: responseId, item_id: messageId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  };
  const startToolCall = (deltaCall) => {
    startResponse();
    const index = deltaCall.index ?? 0;
    if (toolCalls.has(index)) return toolCalls.get(index);

    const call = {
      id: deltaCall.id || id("call"),
      itemId: id("fc"),
      name: deltaCall.function?.name || "",
      arguments: "",
    };
    toolCalls.set(index, call);
    outputItems.push({ type: "function_call", id: call.itemId, call });
    sendEvent("response.output_item.added", {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: outputItems.length - 1,
      item: { id: call.itemId, type: "function_call", call_id: call.id, name: call.name, status: "in_progress" },
    });
    return call;
  };

  for await (const data of parseSse(upstream.body)) {
    if (!data || data === "[DONE]") continue;
    const delta = JSON.parse(data).choices?.[0]?.delta;
    const piece = delta?.content || "";
    if (piece) {
      startText();
      text += piece;
      sendEvent("response.output_text.delta", { type: "response.output_text.delta", response_id: responseId, item_id: messageId, output_index: outputItems.findIndex((item) => item.id === messageId), content_index: 0, delta: piece });
    }

    for (const deltaCall of delta?.tool_calls || []) {
      const call = startToolCall(deltaCall);
      if (deltaCall.function?.name) call.name = deltaCall.function.name;
      const argDelta = deltaCall.function?.arguments || "";
      if (!argDelta) continue;
      call.arguments += argDelta;
      sendEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        response_id: responseId,
        item_id: call.itemId,
        output_index: outputItems.findIndex((item) => item.id === call.itemId),
        delta: argDelta,
      });
    }
  }

  startResponse();
  if (!outputItems.length) startText();

  const output = [];

  if (textStarted) {
    const outputIndex = outputItems.findIndex((item) => item.id === messageId);
    const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    output.push(item);
    sendEvent("response.output_text.done", { type: "response.output_text.done", response_id: responseId, item_id: messageId, output_index: outputIndex, content_index: 0, text });
    sendEvent("response.output_item.done", { type: "response.output_item.done", response_id: responseId, output_index: outputIndex, item });
  }

  for (const call of toolCalls.values()) {
    const outputIndex = outputItems.findIndex((item) => item.id === call.itemId);
    const item = { id: call.itemId, type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: call.arguments };
    output.push(item);
    sendEvent("response.function_call_arguments.done", { type: "response.function_call_arguments.done", response_id: responseId, item_id: call.itemId, output_index: outputIndex, arguments: call.arguments, name: call.name, call_id: call.id });
    sendEvent("response.output_item.done", { type: "response.output_item.done", response_id: responseId, output_index: outputIndex, item });
  }

  sendEvent("response.completed", { type: "response.completed", response: { id: responseId, object: "response", status: "completed", model, output, output_text: text } });
}

export function handleUpgrade(req, socket) {
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const host = req.headers.host || `${HOST}:${currentPort()}`;
  const url = new URL(req.url, `http://${host}`);

  if (url.pathname !== "/v1/responses") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }

  if (!apiKey) {
    socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let handled = false;
  const readFrame = createWebSocketFrameReader(socket, (message) => {
    if (handled) return;
    handled = true;
    void websocketResponse(message, socket, apiKey).catch((error) => {
      sendWebSocketJson(socket, { type: "error", error: { message: error.message } });
      closeWebSocket(socket, 1011, "DeepCodex error");
    });
  });
  socket.on("data", readFrame);
}

async function websocketResponse(message, socket, apiKey) {
  let body;
  try {
    body = JSON.parse(message);
  } catch {
    sendWebSocketJson(socket, { type: "error", error: { message: "Invalid JSON body." } });
    closeWebSocket(socket, 1003, "Invalid JSON");
    return;
  }

  let chatRequest;
  try {
    chatRequest = await buildChatRequest({ ...body, stream: true }, apiKey);
  } catch (error) {
    sendWebSocketJson(socket, { type: "error", error: { message: error.message } });
    closeWebSocket(socket, 1011, "Request failed");
    return;
  }

  const upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(chatRequest),
  });

  if (!upstream.ok) {
    sendWebSocketJson(socket, { type: "error", error: { message: await upstream.text() } });
    closeWebSocket(socket, 1011, "Upstream failed");
    return;
  }

  await streamResponseEvents(upstream, chatRequest.model, (_event, data) => {
    sendWebSocketJson(socket, data);
  });
  setTimeout(() => closeWebSocket(socket), 60000).unref?.();
}

export async function* parseSse(readable) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of readable) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let split;
    while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, split);
      const match = buffer.match(/\r?\n\r?\n/);
      buffer = buffer.slice(split + match[0].length);
      yield dataOf(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield dataOf(buffer);
}

function createWebSocketFrameReader(socket, onText) {
  let buffer = Buffer.alloc(0);
  let fragmentedText = "";

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          closeWebSocket(socket, 1009, "Message too large");
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;

      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        const decoded = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) decoded[i] = payload[i] ^ mask[i % 4];
        payload = decoded;
      }

      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        closeWebSocket(socket);
        return;
      }
      if (opcode === 0x9) {
        sendWebSocketFrame(socket, 0xA, payload);
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x0) continue;

      const text = payload.toString("utf8");
      if (opcode === 0x1 && fin) {
        onText(text);
      } else {
        fragmentedText += text;
        if (fin) {
          onText(fragmentedText);
          fragmentedText = "";
        }
      }
    }
  };
}

function sendWebSocketJson(socket, payload) {
  sendWebSocketFrame(socket, 0x1, Buffer.from(JSON.stringify(payload), "utf8"));
}

function closeWebSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed) return;
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  sendWebSocketFrame(socket, 0x8, payload);
  socket.end();
}

function sendWebSocketFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function dataOf(block) {
  return block
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
}

async function fetchDeepSeekJson(pathname, apiKey) {
  const upstream = await fetch(`${DEEPSEEK_BASE_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!upstream.ok) throw new Error(`DeepSeek ${pathname} failed: ${upstream.status}`);
  return upstream.json();
}

async function read(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function id(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function startServer() {
  const preferredPort = Number(process.env.PORT || process.env.DEEPCODEX_PORT || DEFAULT_PORT);
  const server = http.createServer(handleRequest);
  let port = preferredPort;

  server.on("upgrade", handleUpgrade);

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port === preferredPort) {
      server.listen(0, HOST);
      return;
    }
    throw error;
  });

  server.on("listening", () => {
    port = server.address().port;
    process.env.DEEPCODEX_PORT = String(port);
    console.log(`DeepCodex started: http://${HOST}:${port}/v1/responses`);
  });

  server.listen(port, HOST);
  return server;
}

function currentPort() {
  return Number(process.env.DEEPCODEX_PORT || process.env.PORT || DEFAULT_PORT);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}


