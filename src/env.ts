import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal, dependency-free .env loader. Loads KEY=VALUE pairs from a .env file into
 * process.env without overwriting values already set in the real environment, so an
 * explicit `FOO=bar pnpm ...` still wins. Imported for its side effect by the live
 * entrypoints (server, connect, pay).
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Load on import so entrypoints only need `import "../env.js"`.
loadDotEnv();
