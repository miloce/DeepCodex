import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { enable, restore, status, updateBaseUrl } from "../src/codex-config.js";
import { chatToResponse, handleRequest, handleUpgrade, inputToMessages, parseSse, textOf } from "../src/server.js";

const templateCatalog = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "cc-switch-model-catalog.json"), "utf8"));

test("extracts Responses text input", () => {
  assert.equal(textOf([{ type: "input_text", text: "hi" }, { type: "text", text: "!" }]), "hi!");
});

test("converts input to chat messages", () => {
  assert.deepEqual(inputToMessages("hello", "sys"), [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ]);
});

test("converts chat completion to response", () => {
  const out = chatToResponse({ choices: [{ message: { content: "ok" } }] }, "remote-model");
  assert.equal(out.output_text, "ok");
  assert.equal(out.model, "remote-model");
});

test("parses SSE data blocks", async () => {
  const stream = Readable.from(["data: one\n\n", "data: two\n\n"]);
  const out = [];
  for await (const data of parseSse(stream)) out.push(data);
  assert.deepEqual(out, ["one", "two"]);
});

test("GET /v1 returns bridge status for browser checks", async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  const server = http.createServer(handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/v1`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.service, "deepcodex");
    assert.equal(body.status, "ok");
    assert.equal(body.has_key, false);
    assert.match(body.base_url, /\/v1$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousKey == null) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test("websocket /v1/responses streams Responses events", async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let upstreamBody;

  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const server = http.createServer(handleRequest);
  const upgradedSockets = new Set();
  server.on("upgrade", (req, socket) => {
    upgradedSockets.add(socket);
    socket.on("close", () => upgradedSockets.delete(socket));
    handleUpgrade(req, socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const events = await websocketRoundTrip(server.address().port, {
      type: "response.create",
      model: "deepseek-v4-flash",
      input: "hello",
      stream: true,
    });

    assert.equal(upstreamBody.model, "deepseek-v4-flash");
    assert.deepEqual(upstreamBody.messages, [{ role: "user", content: "hello" }]);
    assert.equal(events.find((event) => event.type === "response.completed")?.response?.output_text, "ok");
  } finally {
    for (const socket of upgradedSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test("codex config switches and restores", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-"));
  const config = path.join(dir, "config.toml");
  const originalConfig = 'model = "origin"\n\n[features]\njs_repl = false\n';
  fs.writeFileSync(config, originalConfig, "utf8");

  try {
    enable({ model: "remote-model", codexDir: dir });
    assert.equal(status({ codexDir: dir }).managed, true);
    const updated = fs.readFileSync(config, "utf8");
    assert.match(updated, /remote-model/);
    assert.match(updated, /http:\/\/127\.0\.0\.1:1314\/v1/);
    assert.match(updated, /model_catalog_json = ".*deepcodex\.models\.json"/);
    assert.ok(updated.indexOf('model_provider = "custom"') < updated.indexOf("[model_providers.custom]"));
    assert.match(updated, /\[model_providers\.custom\]/);
    assert.match(updated, /base_url = "http:\/\/127\.0\.0\.1:1314\/v1"/);
    assert.match(updated, /wire_api = "responses"/);
    assert.match(updated, /requires_openai_auth = true/);
    assert.match(updated, /experimental_bearer_token = "sk-local-proxy"/);
    assert.doesNotMatch(updated, /model_provider = "openai"/);
    assert.doesNotMatch(updated, /openai_base_url/);
    assert.match(updated, /js_repl = false/);
    assert.equal((updated.match(/\[features\]/g) || []).length, 1);
    assert.doesNotMatch(updated, /\[model_providers\.deepcodex-deepseek\]/);
    const catalogPath = path.join(dir, "deepcodex.models.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.deepEqual(catalog, templateCatalog);
    assert.equal(catalog.models[0].slug, "deepseek-v4-flash");
    assert.equal(catalog.models[0].display_name, "DeepSeek V4 Flash");
    assert.equal(catalog.models[0].priority, 1000);
    assert.equal(catalog.models[0].apply_patch_tool_type, "freeform");
    assert.equal(catalog.models[0].context_window, 1000000);
    assert.equal(catalog.models[0].supports_image_detail_original, true);
    assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, "models_cache.json"), "utf8"));
    assert.equal(cache.models[0].slug, "deepseek-v4-flash");

    restore({ codexDir: dir });
    assert.equal(status({ codexDir: dir }).managed, false);
    assert.equal(fs.readFileSync(config, "utf8"), originalConfig);
    assert.equal(fs.existsSync(catalogPath), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "models_cache.json"), "utf8")).models.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex config writes all fetched DeepSeek models into catalog", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-"));
  fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({
    fetched_at: "2026-01-01T00:00:00.000Z",
    etag: "original",
    client_version: "test",
    models: [{ slug: "gpt-5.5", display_name: "GPT-5.5" }],
  }), "utf8");

  try {
    enable({
      model: "deepseek-v4-flash",
      models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
      codexDir: dir,
    });
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "deepcodex.models.json"), "utf8"));
    assert.deepEqual(catalog.models.map((item) => item.slug), ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.deepEqual(catalog.models.map((item) => item.display_name), ["DeepSeek V4 Flash", "DeepSeek V4 Pro"]);
    assert.deepEqual(catalog.models.map((item) => item.priority), [1000, 1001]);
    assert.deepEqual(catalog, templateCatalog);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, "models_cache.json"), "utf8"));
    assert.equal(cache.etag, "original");
    assert.deepEqual(cache.models.map((item) => item.slug), ["deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.5"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex config always writes the bundled cc-switch model catalog", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-"));
  fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({
    models: [{
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      supported_in_api: true,
      visibility: "list",
    }],
  }), "utf8");

  try {
    enable({ model: "deepseek-v4-flash", codexDir: dir });
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "deepcodex.models.json"), "utf8"));
    assert.deepEqual(catalog, templateCatalog);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex config repairs malformed old managed markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-"));
  const config = path.join(dir, "config.toml");
  fs.writeFileSync(config, `model = "deepseek-v4-flash"
model_provider = "deepcodex-deepseek"

# >>> deepcodex-deepseek

# >>> deepcodex-deepseek
model_catalog_json = "C:\\\\Users\\\\old\\\\.codex\\\\deepcodex.models.json"

# >>> deepcodex-deepseek
[model_providers.deepcodex-deepseek]
name = "DeepCodex"
base_url = "http://127.0.0.1:1314/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
# <<< deepcodex-deepseek

[features]
js_repl = false
`, "utf8");

  try {
    enable({ model: "deepseek-v4-pro", models: [{ id: "deepseek-v4-pro" }], codexDir: dir });
    const updated = fs.readFileSync(config, "utf8");
    assert.equal((updated.match(/# >>> deepcodex-deepseek/g) || []).length, 1);
    assert.equal((updated.match(/# <<< deepcodex-deepseek/g) || []).length, 1);
    assert.match(updated, /model_catalog_json = ".*deepcodex\.models\.json"/);
    assert.match(updated, /model = "deepseek-v4-pro"/);
    assert.equal((updated.match(/\[model_providers\.deepcodex-deepseek\]/g) || []).length, 0);
    assert.match(updated, /model_provider = "custom"/);
    assert.match(updated, /\[model_providers\.custom\]/);
    assert.match(updated, /base_url = "http:\/\/127\.0\.0\.1:1314\/v1"/);
    assert.doesNotMatch(updated, /model_provider = "openai"/);
    assert.doesNotMatch(updated, /openai_base_url/);
    assert.equal((updated.match(/\[features\]/g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex config can use a runtime-selected bridge port", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-"));
  const config = path.join(dir, "config.toml");
  fs.writeFileSync(config, '[features]\njs_repl = false\n', "utf8");

  try {
    enable({ model: "remote-model", codexDir: dir, baseUrl: "http://127.0.0.1:45678/v1" });
    const updated = fs.readFileSync(config, "utf8");
    assert.match(updated, /http:\/\/127\.0\.0\.1:45678\/v1/);
    assert.match(updated, /model_provider = "custom"/);
    assert.match(updated, /\[model_providers\.custom\]/);
    assert.doesNotMatch(updated, /openai_base_url/);
    assert.doesNotMatch(updated, /\[model_providers\.deepcodex-deepseek\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex config managed base URL can be updated without restoring", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-"));

  try {
    enable({ model: "remote-model", codexDir: dir });
    updateBaseUrl({ codexDir: dir, baseUrl: "http://127.0.0.1:56789/v1" });
    const updated = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(updated, /base_url = "http:\/\/127\.0\.0\.1:56789\/v1"/);
    assert.match(updated, /model = "remote-model"/);
    assert.match(updated, /model_provider = "custom"/);
    assert.doesNotMatch(updated, /openai_base_url/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function websocketRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    const events = [];
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket probe timed out."));
    }, 5000);

    socket.on("connect", () => {
      socket.write(
        "GET /v1/responses HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const split = buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const headers = buffer.subarray(0, split).toString("utf8");
        assert.match(headers, /^HTTP\/1\.1 101 /);
        buffer = buffer.subarray(split + 4);
        upgraded = true;
        socket.write(maskedClientFrame(JSON.stringify(payload)));
      }

      for (const message of readServerFrames()) {
        const event = JSON.parse(message);
        events.push(event);
        if (event.type === "response.completed") {
          clearTimeout(timeout);
          socket.destroy();
          resolve(events);
        }
      }
    });

    function readServerFrames() {
      const messages = [];
      while (buffer.length >= 2) {
        const first = buffer[0];
        const opcode = first & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < offset + 2) break;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) break;
          length = Number(buffer.readBigUInt64BE(offset));
          offset += 8;
        }

        if (buffer.length < offset + length) break;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x1) messages.push(payload.toString("utf8"));
      }
      return messages;
    }
  });
}

function maskedClientFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const encoded = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) encoded[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, encoded]);
}

