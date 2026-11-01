#!/usr/bin/env node
/**
 * 带环境变量占位符渲染的 Cloudflare 部署脚本
 *
 * 背景：wrangler 4.x **不支持** 在 wrangler.jsonc 里写 `${VAR}` 插值——
 * 无论从 .dev.vars、.env 还是 shell 环境变量读，wrangler 都会把字面量
 * `${VAR}` 原样发给 Cloudflare API，导致：
 *   binding DB of type d1 must have a valid `database_id` specified [code: 10021]
 * （已实测 wrangler 4.72.0 / 4.118.0 行为一致）
 *
 * 因此本脚本在部署前做一次「渲染」：把 wrangler.jsonc 里的 ${占位符}
 * 用环境变量的值替换掉，写入一个临时配置文件，再让 wrangler 用它部署。
 * 渲染后的文件写在 .wrangler/ 下（已被 .gitignore 忽略），不进仓库。
 *
 * 用法：
 *   D1_DATABASE_ID=<uuid> node scripts/deploy-with-env.js [wrangler deploy 的其他参数...]
 *
 * 环境变量来源优先级：
 *   1. 进程环境变量（如 D1_DATABASE_ID=xxx node scripts/deploy-with-env.js）
 *   2. .dev.vars 文件（本地开发用，dotenv 格式，已被 .gitignore 忽略）
 *   3. .env 文件
 *
 * 未设置必需的占位符时直接报错退出，不会带着字面量去部署。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_CONFIG = path.join(ROOT, "wrangler.jsonc");
// 渲染产物放这里；.gitignore 里已忽略 .wrangler/
// 注意：必须放在仓库根（不能放 .wrangler/deploy/ 子目录）——wrangler 以配置文件所在
// 目录为基准解析 main / assets.directory 等相对路径，放子目录会报
// "The entry-point file at src/backend/worker.ts was not found"。
const OUT_CONFIG = path.join(ROOT, "wrangler.rendered.jsonc");

/** 从 dotenv 风格文件里读 key=value */
function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 从 wrangler.jsonc 文本里抠出所有 ${VAR} 占位符 */
function findPlaceholders(text) {
  const found = new Set();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return [...found];
}

function runWrangler(configPath) {
  const args = ["wrangler", "deploy", "--config", configPath, ...process.argv.slice(2)];
  console.log(`[信息] 执行：npx ${args.join(" ")}`);
  const result = spawnSync("npx", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`[错误] 启动 wrangler 失败：${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function main() {
  const fromFiles = {
    ...loadDotEnv(path.join(ROOT, ".env")),
    ...loadDotEnv(path.join(ROOT, ".dev.vars")),
  };

  let raw;
  try {
    raw = fs.readFileSync(SRC_CONFIG, "utf8");
  } catch {
    console.error(`[错误] 读取配置失败：${SRC_CONFIG}`);
    process.exit(1);
  }

  const placeholders = findPlaceholders(raw);
  if (placeholders.length === 0) {
    console.log("[信息] 配置里没有 ${VAR} 占位符，直接部署。");
    return runWrangler(path.join(ROOT, "wrangler.jsonc"));
  }

  const missing = [];
  const resolved = {};
  for (const key of placeholders) {
    const value = process.env[key] ?? fromFiles[key];
    if (value === undefined || value === "") {
      missing.push(key);
    } else {
      resolved[key] = value;
    }
  }

  if (missing.length > 0) {
    console.error(
      `[错误] 缺少必需的环境变量：${missing.join(", ")}\n` +
        `  设置方式（任选其一）：\n` +
        `    1) 命令行前置：  ${missing.map((k) => `${k}=<value>`).join(" ")} node scripts/deploy-with-env.js\n` +
        `    2) 写进 .dev.vars（已在 .gitignore 中，不会进仓库）\n` +
        `    3) 写进 .env\n` +
        `  占位符位置：${SRC_CONFIG}`,
    );
    process.exit(1);
  }

  let rendered = raw;
  for (const [key, value] of Object.entries(resolved)) {
    rendered = rendered.split(`\${${key}}`).join(value);
  }

  // 渲染后不应再有未解析的占位符
  const leftover = findPlaceholders(rendered);
  if (leftover.length > 0) {
    console.error(`[错误] 渲染后仍存在未替换的占位符：${leftover.join(", ")}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_CONFIG), { recursive: true });
  fs.writeFileSync(OUT_CONFIG, rendered);
  console.log(
    `[信息] 已渲染 ${placeholders.length} 个占位符（${placeholders
      .map((k) => `${k} ✓`)
      .join(", ")}）→ ${path.relative(ROOT, OUT_CONFIG)}`,
  );

  return runWrangler(OUT_CONFIG);
}

main();
