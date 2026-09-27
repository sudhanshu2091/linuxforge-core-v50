#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const path = ".env.local";
if (!fs.existsSync(path)) {
  console.error("Missing .env.local. Copy it from your previous LinuxForge project first.");
  process.exit(1);
}

const text = fs.readFileSync(path, "utf8");
const env = {};
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  env[match[1]] = value;
}

const required = [
  "FORGE_SANDBOX_PROVIDER",
  "FORGE_SANDBOX_ENDPOINT",
  "FORGE_SANDBOX_IMAGE",
  "FORGE_SANDBOX_RUNTIME_MODE",
  "FORGE_SANDBOX_RUNTIME_CLASS",
  "FORGE_SANDBOX_CREDENTIAL",
  "FORGE_RUNTIME_SERVICE_TOKEN",
  "FORGE_TERMINAL_TICKET_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
];
const missing = required.filter((key) => !env[key]);
if (missing.length) {
  console.error(`Missing required .env.local keys: ${missing.join(", ")}`);
  process.exit(1);
}

const expected = {
  FORGE_SANDBOX_PROVIDER: "real-linux-isolated-v1",
  FORGE_SANDBOX_ENDPOINT: "http://127.0.0.1:18080",
  FORGE_SANDBOX_RUNTIME_MODE: "development",
  FORGE_SANDBOX_RUNTIME_CLASS: "vm",
};
for (const [key, value] of Object.entries(expected)) {
  if (env[key] !== value) {
    console.error(`${key} is ${JSON.stringify(env[key])}; expected ${JSON.stringify(value)} for the local QEMU development runtime.`);
    process.exit(1);
  }
}

console.log("LinuxForge local configuration: OK");
console.log(`provider=${env.FORGE_SANDBOX_PROVIDER}`);
console.log(`endpoint=${env.FORGE_SANDBOX_ENDPOINT}`);
console.log(`image=${env.FORGE_SANDBOX_IMAGE}`);
console.log(`runtimeClass=${env.FORGE_SANDBOX_RUNTIME_CLASS}`);
console.log("secrets present=yes (values not printed)");
