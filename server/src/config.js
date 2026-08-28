// Configuration. Everything the app needs to run, resolved once, in one place.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// A .env file is a convenience for local work; real deployments set env vars.
// We never overwrite something already in the environment.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://ts_app:ts_app_dev@127.0.0.1:5432/ts_workspace",
  databaseUrlRo:
    process.env.DATABASE_URL_RO ||
    "postgres://ts_readonly:ts_readonly_dev@127.0.0.1:5432/ts_workspace",
  model: "claude-opus-5",
  // High effort is the default; this work is judgement-heavy and the volume is
  // low enough that the extra tokens are not the cost that matters.
  effort: process.env.CLAUDE_EFFORT || "high",
  maxTokens: 32000,
  maxToolIterations: 12,
  // Set at build time from the pricing published for the model above, in USD
  // per million tokens. Cache writes bill at 1.25x input, reads at 0.1x.
  pricing: { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
};

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// Cost of one API response, in dollars, from its usage block.
export function costOf(usage) {
  if (!usage) return 0;
  const p = config.pricing;
  const m = 1e-6;
  return (
    (usage.input_tokens || 0) * p.input * m +
    (usage.output_tokens || 0) * p.output * m +
    (usage.cache_creation_input_tokens || 0) * p.cacheWrite * m +
    (usage.cache_read_input_tokens || 0) * p.cacheRead * m
  );
}
