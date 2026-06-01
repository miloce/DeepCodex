#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const root = process.cwd();
const envPath = path.join(root, ".env");

const rl = readline.createInterface({ input, output });

try {
  console.log("DeepCodex Bridge 初始化");
  console.log("只需要填 DeepSeek API Key。\n");

  const key = await askRequired("DeepSeek API Key");

  const content = [
    `DEEPSEEK_API_KEY=${key}`,
    "",
  ].join("\n");

  fs.writeFileSync(envPath, content, "utf8");
  console.log(`\n已写入：${envPath}`);
  console.log("现在可以运行：npm start");
} finally {
  rl.close();
}

async function askRequired(label) {
  while (true) {
    const value = (await rl.question(`${label}: `)).trim();
    if (value) return value;
    console.log("不能为空，请重新输入。");
  }
}
