#!/usr/bin/env node
import { loadEnv, listDeepSeekModels } from "./server.js";

loadEnv();

const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.error("Missing DEEPSEEK_API_KEY");
  process.exit(1);
}

const models = await listDeepSeekModels(key);
for (const model of models.data || []) {
  if (model?.id) console.log(model.id);
}
