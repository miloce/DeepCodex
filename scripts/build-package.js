#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "deepcodex-node");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyFile("README.md");
copyFile("package.json");
copyFile("package-lock.json");
copyFile(".env.example");
copyDir("src");

fs.writeFileSync(
  path.join(outDir, "USAGE.txt"),
  [
    "DeepCodex Node.js CLI",
    "Copyright (c) miloce",
    "Project: https://github.com/miloce/DeepCodex",
    "",
    "Requirements:",
    "- Node.js 18+",
    "",
    "Commands:",
    "npm install",
    "npm start",
    "",
    "Bridge only:",
    "npm run bridge",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Built package: ${path.relative(root, outDir)}`);

function copyFile(relativePath) {
  fs.copyFileSync(path.join(root, relativePath), path.join(outDir, relativePath));
}

function copyDir(relativePath) {
  const from = path.join(root, relativePath);
  const to = path.join(outDir, relativePath);
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const childRelative = path.join(relativePath, entry.name);
    if (entry.isDirectory()) copyDir(childRelative);
    else if (entry.isFile()) copyFile(childRelative);
  }
}
