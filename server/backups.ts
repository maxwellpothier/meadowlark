import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./db.ts";
import type { Store } from "./store.ts";

const EVERY_MS = 60 * 60 * 1000;
const KEPT = 48;

/**
 * Writes a consistent copy of the database to <data dir>/backups now and then
 * every hour, skipping hours where nothing changed. Copying the live file
 * mid-write can give a corrupt backup; VACUUM INTO can't. These copies are
 * what the machine's own backup (Time Machine etc.) should pick up.
 */
export function startBackups(store: Store, dir = join(dataDir(), "backups")): () => void {
  mkdirSync(dir, { recursive: true });
  let lastFingerprint = "";
  const run = () => {
    try {
      const pages = store.listPages();
      const fingerprint = pages.map((p) => `${p.id}:${p.updatedAt}:${p.name}`).sort().join("|");
      if (pages.length === 0 || fingerprint === lastFingerprint) return;
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
      store.backupTo(join(dir, `meadowlark-${stamp}Z.db`)); // UTC
      lastFingerprint = fingerprint;
      const old = readdirSync(dir).filter((f) => /^meadowlark-.*\.db$/.test(f)).sort().slice(0, -KEPT);
      for (const file of old) rmSync(join(dir, file));
    } catch (err) {
      console.error("Backup failed", err);
    }
  };
  run();
  const timer = setInterval(run, EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
