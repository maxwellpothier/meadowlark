import { HttpAdapter } from "./http";
import { serialized } from "./serialized";
import type { StorageAdapter } from "./types";

// The one place that decides where data lives: the local Meadowlark server,
// which shares its SQLite file with Claude's MCP server.
export const storage: StorageAdapter = serialized(new HttpAdapter());
