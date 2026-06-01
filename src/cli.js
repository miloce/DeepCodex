#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { enable, restore, status as codexStatus, updateBaseUrl } from "./codex-config.js";
import { DEFAULT_PORT, listDeepSeekModels, loadEnv, startServer } from "./server.js";

const appDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir(), "DeepCodex");
const invokedPath = process.argv[0] || process.execPath;
const runningAsNode = /^node(\.exe)?$/i.test(path.basename(invokedPath));
const packaged = Boolean(process.pkg) || !runningAsNode;
const selfPath = packaged ? invokedPath : process.execPath;
const root = packaged ? path.dirname(selfPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsPath = path.join(appDir, "settings.json");
const pidPath = path.join(appDir, "bridge.pid");
const portPath = path.join(appDir, "bridge.port");
const logPath = path.join(appDir, "bridge.log");
const envPath = packaged ? path.join(appDir, ".env") : path.join(root, ".env");
const PROJECT_URL = "https://github.com/miloce/DeepCodex";
const BRIDGE_START_TIMEOUT_MS = 5000;

let rl;

if (process.env.DEEPCODEX_BRIDGE_CHILD === "1" || process.argv[2] === "__bridge") {
  loadEnv(envPath);
  startServer();
} else {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    loadEnv(envPath);
    await main(process.argv[2]);
  } finally {
    rl.close();
  }
}

async function main(action) {
  if (action === "on") {
    await useDeepSeek();
    return;
  }
  if (action === "off") {
    useOriginal();
    return;
  }
  if (action === "status") {
    await printStatus();
    return;
  }

  console.clear();
  console.log("DeepCodex");
  console.log("让 Codex CLI 可以直接使用 DeepSeek");
  console.log(`GitHub: ${PROJECT_URL}\n`);

  if (!readKey()) {
    await saveKeyFlow();
  }

  if (codexStatus().managed && readKey() && !(await bridgeRunning())) {
    const port = await startBridge(readKey());
    updateBaseUrl({ baseUrl: bridgeBaseUrl(port) });
  }

  while (true) {
    await printStatus();
    console.log("\n1. 使用 DeepSeek");
    console.log("2. 使用原配置");
    console.log("3. 修改 DeepSeek API Key");
    console.log("4. 退出\n");

    const choice = (await rl.question("请选择：")).trim();
    try {
      if (choice === "1") await useDeepSeek();
      else if (choice === "2") useOriginal();
      else if (choice === "3") await saveKeyFlow();
      else if (choice === "4" || choice === "") break;
      else console.log("无效选择。");
    } catch (error) {
      console.log(`失败：${error.message}`);
    }

    await pause();
    console.clear();
  }
}

async function printStatus() {
  const key = readKey();
  const codex = codexStatus();
  const running = await bridgeRunning();
  const port = readPort() || DEFAULT_PORT;
  console.log("当前状态");
  console.log(`- Key：${key ? maskKey(key) : "未配置"}`);
  console.log(`- Codex：${codex.managed ? "DeepSeek" : "原配置"}`);
  console.log(`- Bridge：${running ? `运行中（${bridgeBaseUrl(port)}）` : "未运行"}`);
}

async function saveKeyFlow() {
  const key = (await rl.question("DeepSeek API Key：")).trim();
  if (!key) {
    console.log("Key 不能为空。");
    return;
  }

  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ apiKey: key }, null, 2), "utf8");
  fs.writeFileSync(envPath, `DEEPSEEK_API_KEY=${key}\n`, "utf8");
  process.env.DEEPSEEK_API_KEY = key;

  if (process.platform === "win32") {
    spawnSync("setx", ["DEEPSEEK_API_KEY", key], {
      stdio: "ignore",
      windowsHide: true,
    });
  }

  console.log("Key 已保存。");
}

async function useDeepSeek() {
  let key = readKey();
  if (!key) {
    await saveKeyFlow();
    key = readKey();
    if (!key) return;
  }

  console.log("正在获取 DeepSeek 模型...");
  const models = await listDeepSeekModels(key);
  const model = models.data?.find((item) => item?.id)?.id;
  if (!model) throw new Error("DeepSeek /models 没有返回可用模型。");

  const port = await startBridge(key);
  enable({ model, models: models.data, baseUrl: bridgeBaseUrl(port) });
  console.log(`已切到 DeepSeek：${model}`);
  console.log(`Bridge 地址：${bridgeBaseUrl(port)}`);
  if (port !== DEFAULT_PORT) console.log(`默认端口被占用，已自动改用端口：${port}`);
}

function bridgeBaseUrl(port) {
  return `http://127.0.0.1:${port}/v1`;
}

function useOriginal() {
  restore();
  stopBridge();
  console.log("已切回 Codex 原配置，Bridge 已关闭。");
}

function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (settings.apiKey) return settings.apiKey;
  } catch {}

  try {
    const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((item) => item.startsWith("DEEPSEEK_API_KEY="));
    if (line) return line.slice("DEEPSEEK_API_KEY=".length).trim();
  } catch {}

  return "";
}

async function startBridge(key) {
  const savedPort = readPort();
  if (savedPort && await bridgeHealthy(savedPort)) return savedPort;
  cleanBridgeFiles();

  fs.mkdirSync(appDir, { recursive: true });
  const port = await findAvailablePort(DEFAULT_PORT);
  const command = packaged ? selfPath : process.execPath;
  const args = packaged ? [] : [path.join(root, "src/server.js")];
  fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] starting bridge on ${port}\n`, "utf8");
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      DEEPCODEX_BRIDGE_CHILD: packaged ? "1" : "",
      DEEPSEEK_API_KEY: key,
      PORT: String(port),
      DEEPCODEX_PORT: String(port),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(pidPath, String(child.pid), "utf8");
  fs.writeFileSync(portPath, String(port), "utf8");

  const ready = await waitForBridge(port, BRIDGE_START_TIMEOUT_MS);
  if (!ready) {
    cleanBridgeFiles();
    throw new Error(`Bridge 启动失败；端口 ${port} 没有响应。日志：${logPath}`);
  }

  return port;
}

function stopBridge() {
  const pid = readPid();
  if (!pid) {
    cleanBridgeFiles();
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(pid);
    } catch {}
  }

  cleanBridgeFiles();
}

async function bridgeRunning() {
  const port = readPort();
  if (!port) return false;
  const ok = await bridgeHealthy(port);
  if (!ok) cleanBridgeFiles();
  return ok;
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function readPort() {
  try {
    const port = Number(fs.readFileSync(portPath, "utf8").trim());
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
}

function cleanBridgeFiles() {
  fs.rmSync(pidPath, { force: true });
  fs.rmSync(portPath, { force: true });
}

async function waitForBridge(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await bridgeHealthy(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function bridgeHealthy(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function findAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", (error) => {
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      const fallback = http.createServer();
      fallback.once("error", reject);
      fallback.listen(0, "127.0.0.1", () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(preferredPort, "127.0.0.1", () => {
      server.close(() => resolve(preferredPort));
    });
  });
}

function maskKey(key) {
  if (key.length <= 10) return "已保存";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

async function pause() {
  await rl.question("\n按回车继续...");
}
