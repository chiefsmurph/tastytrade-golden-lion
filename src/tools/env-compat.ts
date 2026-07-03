// Shared by the src/tools/ probes: load .env and accept both current (CORE_*)
// and legacy (BASE_URL/API_*) names so the tools run against the server's
// un-migrated .env as well as a local one. Import this before ~/core modules.
import { config } from "dotenv";

config();

for (const [core, legacy] of [
  ["CORE_BASE_URL", "BASE_URL"],
  ["CORE_API_CLIENT_SECRET", "API_CLIENT_SECRET"],
  ["CORE_API_REFRESH_TOKEN", "API_REFRESH_TOKEN"],
] as const) {
  if (!process.env[core]?.trim() && process.env[legacy]?.trim()) {
    process.env[core] = process.env[legacy];
  }
}
