import { restoreElements } from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { pickPersistedAppState } from "../storage/scene";
import type { Backup, BackupPage, StorageAdapter } from "../storage/types";

const BACKUP_TYPE = "meadowlark-backup";

/**
 * Builds the backup as a Blob from per-page JSON chunks so we never hold one
 * giant string containing every page's images at once.
 */
export async function buildBackupBlob(storage: StorageAdapter): Promise<{ blob: Blob; count: number }> {
  const metas = await storage.listPages();
  metas.sort((a, b) => a.order - b.order);
  const header: Omit<Backup, "pages"> = { type: BACKUP_TYPE, version: 1, exportedAt: Date.now() };
  const parts: string[] = [JSON.stringify(header).slice(0, -1), ',"pages":['];
  let count = 0;
  for (const meta of metas) {
    const page = await storage.getPage(meta.id);
    if (!page) continue;
    const { view: _view, claude: _claude, ...rest } = page;
    const backupPage: BackupPage = rest;
    parts.push((count > 0 ? "," : "") + JSON.stringify(backupPage));
    count++;
  }
  parts.push("]}");
  return { blob: new Blob(parts, { type: "application/json" }), count };
}

export async function parseBackup(file: Blob): Promise<BackupPage[]> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  if (!isRecord(data) || data.type !== BACKUP_TYPE || !Array.isArray(data.pages)) {
    throw new Error("This doesn't look like a Meadowlark backup.");
  }
  if (data.version !== 1) throw new Error(`Unsupported backup version: ${String(data.version)}`);

  return data.pages.map((raw, i): BackupPage => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) {
      throw new Error(`Backup page #${i + 1} is missing an id.`);
    }
    const now = Date.now();
    return {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "Untitled",
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
      order: typeof raw.order === "number" ? raw.order : i,
      pinnedAt: typeof raw.pinnedAt === "number" ? raw.pinnedAt : null,
      inbox: raw.inbox === true,
      savedAt: typeof raw.savedAt === "number" ? raw.savedAt : null,
      // restoreElements repairs/migrates elements exactly as a .excalidraw load would.
      elements: restoreElements(Array.isArray(raw.elements) ? raw.elements : [], null),
      appState: pickPersistedAppState(isRecord(raw.appState) ? raw.appState : null),
      files: isRecord(raw.files) ? (raw.files as BinaryFiles) : {},
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
