import { cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync(".generated", { recursive: true });
cpSync("vendor/novnc", ".generated/novnc", { recursive: true, force: true });
try {
  execFileSync(
    "uv",
    ["run", "python", "../internal/cage/novnc-patch.py", ".generated/novnc"],
    { stdio: "inherit" },
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.error("uv was not found on PATH. Install it from https://docs.astral.sh/uv/getting-started/installation/ and rerun the UI build.");
  process.exitCode = 1;
}
