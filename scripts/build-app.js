#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = { win32: "win", darwin: "macos", linux: "linux" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];

if (!platform || !arch) {
  throw new Error(`Unsupported build platform: ${process.platform}-${process.arch}`);
}

const target = `node22-${platform}-${arch}`;
const outDir = path.join(root, "dist", "app");
const exeName = process.platform === "win32" ? "deepcodex.exe" : "deepcodex";

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const command = process.platform === "win32" ? "cmd.exe" : "npx";
const pkgArgs = [
    "pkg",
    ".",
    "--targets",
    target,
    "--output",
    path.join(outDir, exeName),
    "--no-bytecode",
    "--no-signature",
    "--public-packages",
    "*",
  ];
const args = process.platform === "win32" ? ["/d", "/c", "npx", ...pkgArgs] : pkgArgs;

const result = spawnSync(
  command,
  args,
  {
    cwd: root,
    stdio: "inherit",
    shell: false,
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

fs.writeFileSync(
  path.join(outDir, "README.txt"),
  [
    "DeepCodex application",
    "Copyright (c) miloce",
    "Project: https://github.com/miloce/DeepCodex",
    "",
    "Run:",
    process.platform === "win32" ? "deepcodex.exe" : "./deepcodex",
    "",
    "The app is a standalone CLI application.",
    "No Node.js installation is required for this artifact.",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Built app: ${path.relative(root, path.join(outDir, exeName))}`);
