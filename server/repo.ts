import { execFileSync } from "node:child_process";

/**
 * Identifies the repo a Claude session is working in: its origin remote
 * (without credentials) or, failing that, the repo's top-level path.
 */
export function detectRepo(cwd = process.cwd()): string | null {
  const remote = git(cwd, "remote", "get-url", "origin");
  if (remote) return remote.replace(/^(\w+:\/\/)[^@/]+@/, "$1");
  return git(cwd, "rev-parse", "--show-toplevel");
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}
