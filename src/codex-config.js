#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROVIDER = "custom";
export const DEFAULT_BASE_URL = "http://127.0.0.1:1314/v1";

const START = "# >>> deepcodex-deepseek";
const END = "# <<< deepcodex-deepseek";
const CATALOG_FILE = "deepcodex.models.json";
const MODELS_CACHE_FILE = "models_cache.json";
const CATALOG_TEMPLATE_FILE = "cc-switch-model-catalog.json";
const CATALOG_TEMPLATE_PATH = fileURLToPath(new URL(`./${CATALOG_TEMPLATE_FILE}`, import.meta.url));
const LEGACY_PROVIDERS = ["deepcodex-deepseek"];

export function paths(options = {}) {
  const dir = options.codexDir || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    dir,
    config: path.join(dir, "config.toml"),
    meta: path.join(dir, "deepcodex.backup.json"),
  };
}

export function status(options = {}) {
  const p = paths(options);
  const text = fs.existsSync(p.config) ? fs.readFileSync(p.config, "utf8") : "";
  return {
    managed: text.includes(START),
    configPath: p.config,
    backupExists: fs.existsSync(p.meta),
  };
}

export function enable({ model, models = [], codexDir, baseUrl = DEFAULT_BASE_URL } = {}) {
  if (!model) throw new Error("Missing model. Fetch DeepSeek /models first.");

  const p = paths({ codexDir });
  fs.mkdirSync(p.dir, { recursive: true });
  backupOnce(p);
  const catalog = writeModelCatalog(p.dir, model, models);
  syncModelsCache(p.dir, catalog.models);

  const current = fs.existsSync(p.config) ? fs.readFileSync(p.config, "utf8") : "";
  const cleaned = removeRootKeys(removeProviderTable(removeManagedBlock(current)), ["openai_base_url"]);
  const next = writeRootKeys(cleaned, {
    model,
    model_provider: PROVIDER,
    model_catalog_json: path.join(p.dir, CATALOG_FILE),
  });

  fs.writeFileSync(p.config, `${insertProviderNearTop(next, baseUrl).trimEnd()}\n`, "utf8");
  return { ok: true, configPath: p.config, model, baseUrl };
}

export function restore(options = {}) {
  const p = paths(options);
  if (!fs.existsSync(p.meta)) return { ok: false, reason: "backup_not_found", configPath: p.config };

  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  if (meta.existed) fs.copyFileSync(meta.backup, p.config);
  else if (fs.existsSync(p.config)) fs.rmSync(p.config);

  removeModelsCacheEntries(p.dir);
  fs.rmSync(path.join(p.dir, CATALOG_FILE), { force: true });
  fs.rmSync(p.meta, { force: true });
  return { ok: true, configPath: p.config };
}

export function updateBaseUrl({ baseUrl, codexDir } = {}) {
  if (!baseUrl) throw new Error("Missing baseUrl.");

  const p = paths({ codexDir });
  if (!fs.existsSync(p.config)) return { ok: false, reason: "config_not_found", configPath: p.config };

  const current = fs.readFileSync(p.config, "utf8");
  const start = current.indexOf(START);
  const end = current.indexOf(END, start);
  if (start === -1 || end === -1) return { ok: false, reason: "not_managed", configPath: p.config };

  const blockEnd = end + END.length;
  const block = current.slice(start, blockEnd);
  const nextBlock = /base_url\s*=/.test(block)
    ? block.replace(/base_url\s*=\s*(['"])[^'"]*\1/, `base_url = ${JSON.stringify(baseUrl)}`)
    : block.replace(END, `base_url = ${JSON.stringify(baseUrl)}\n${END}`);
  const next = `${current.slice(0, start)}${nextBlock}${current.slice(blockEnd)}`;

  fs.writeFileSync(p.config, `${next.trimEnd()}\n`, "utf8");
  return { ok: true, configPath: p.config, baseUrl };
}

function backupOnce(p) {
  if (fs.existsSync(p.meta)) return;

  const existed = fs.existsSync(p.config);
  const backup = path.join(p.dir, `config.deepcodex.${Date.now()}.toml.bak`);
  if (existed) fs.copyFileSync(p.config, backup);
  fs.writeFileSync(p.meta, JSON.stringify({ existed, backup }, null, 2), "utf8");
}

function writeRootKeys(text, values) {
  const lines = text ? text.split(/\r?\n/) : [];
  const seen = new Set();
  let inRoot = true;

  const out = lines.map((line) => {
    if (/^\s*\[/.test(line)) inRoot = false;
    if (!inRoot) return line;

    for (const [key, value] of Object.entries(values)) {
      if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
        seen.add(key);
        return `${key} = ${JSON.stringify(value)}`;
      }
    }

    return line;
  });

  const missing = Object.entries(values)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

  const firstTable = out.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable === -1) return [...missing, ...out].join("\n");
  out.splice(firstTable, 0, ...missing, "");
  return out.join("\n");
}

function removeRootKeys(text, keys) {
  const keySet = new Set(keys);
  let inRoot = true;

  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*\[/.test(line)) inRoot = false;
      if (!inRoot) return true;

      const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
      return !match || !keySet.has(match[1]);
    })
    .join("\n");
}

function insertProviderNearTop(text, baseUrl) {
  const lines = text ? text.split(/\r?\n/) : [];
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const block = ["", ...providerBlock(baseUrl).split("\n"), ""];

  if (firstTable === -1) return [...lines, ...block].join("\n");

  const out = [...lines];
  out.splice(firstTable, 0, ...block);
  return out.join("\n");
}

function providerBlock(baseUrl) {
  return `${START}
[model_providers.${PROVIDER}]
name = "DeepSeek"
base_url = ${JSON.stringify(baseUrl)}
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "sk-local-proxy"
${END}`;
}

function writeModelCatalog(dir, model, models = []) {
  const catalogPath = path.join(dir, CATALOG_FILE);
  const catalog = buildModelCatalog(model, models);

  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return catalog;
}

function buildModelCatalog() {
  const template = readCatalogTemplate();

  return {
    models: template.models.map((item) => cloneJson(item)),
  };
}

function readCatalogTemplate() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_TEMPLATE_PATH, "utf8"));
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) {
      throw new Error(`${CATALOG_TEMPLATE_FILE} must contain models.`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to read ${CATALOG_TEMPLATE_FILE}: ${error.message}`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function syncModelsCache(dir, deepCodexModels) {
  const cachePath = path.join(dir, MODELS_CACHE_FILE);
  const cache = readModelsCache(cachePath);
  const slugs = new Set(deepCodexModels.map((item) => item.slug));
  const existing = Array.isArray(cache.models) ? cache.models : [];
  cache.models = [
    ...deepCodexModels,
    ...existing.filter((item) => !slugs.has(item?.slug)),
  ];
  if (!cache.fetched_at) cache.fetched_at = new Date().toISOString();
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function removeModelsCacheEntries(dir) {
  const cachePath = path.join(dir, MODELS_CACHE_FILE);
  const catalogPath = path.join(dir, CATALOG_FILE);
  if (!fs.existsSync(cachePath) || !fs.existsSync(catalogPath)) return;

  let slugs;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    slugs = new Set((catalog.models || []).map((item) => item?.slug).filter(Boolean));
  } catch {
    return;
  }
  if (slugs.size === 0) return;

  const cache = readModelsCache(cachePath);
  const existing = Array.isArray(cache.models) ? cache.models : [];
  const nextModels = existing.filter((item) => !slugs.has(item?.slug));
  if (nextModels.length === existing.length) return;

  cache.models = nextModels;
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function readModelsCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (Array.isArray(parsed)) return { models: parsed };
    if (parsed && typeof parsed === "object") {
      return { ...parsed, models: Array.isArray(parsed.models) ? parsed.models : [] };
    }
  } catch {}
  return { fetched_at: new Date().toISOString(), etag: null, client_version: null, models: [] };
}

function removeManagedBlock(text) {
  const withoutBlocks = text.replace(new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\s*`, "g"), "");
  return withoutBlocks
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== START && trimmed !== END;
    })
    .join("\n");
}

function removeProviderTable(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skip = false;
  const providerHeaders = new Set([PROVIDER, ...LEGACY_PROVIDERS].map((provider) => `[model_providers.${provider}]`));

  for (const line of lines) {
    if (providerHeaders.has(line.trim())) {
      skip = true;
      continue;
    }
    if (skip && /^\s*\[/.test(line)) skip = false;
    if (!skip) out.push(line);
  }

  return out.join("\n");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const action = process.argv[2] || "status";
  if (action === "status") {
    const s = status();
    console.log(s.managed ? "Codex 当前指向 DeepSeek Bridge" : "Codex 当前未由 DeepCodex 管理");
    console.log(s.configPath);
    return;
  }
  if (action === "off") {
    const r = restore();
    console.log(r.ok ? "Codex 已恢复原配置。" : "没有备份，跳过恢复。");
    return;
  }
  if (action === "on") {
    let model = process.argv[3];
    if (!model) {
      const { loadEnv, listDeepSeekModels } = await import("./server.js");
      loadEnv();
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) throw new Error("Missing DEEPSEEK_API_KEY");
      const models = await listDeepSeekModels(key);
      model = models.data?.find((item) => item?.id)?.id;
      if (!model) throw new Error("DeepSeek /models did not return any model id.");
    }
    const r = enable({ model });
    console.log(`Codex 已切到 DeepSeek：${r.model}`);
    return;
  }
  console.log("用法：node src/codex-config.js status|off|on <model>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}


