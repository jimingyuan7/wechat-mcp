import fs from "node:fs";
import path from "node:path";

import { deriveRawAccountId } from "../auth/accounts.js";

import { resolveStateDir } from "./state-dir.js";

function resolveAccountsDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "accounts");
}

/**
 * Path to the persistent get_updates_buf file for an account.
 * Stored alongside account data: <stateDir>/openclaw-weixin/accounts/{accountId}.sync.json
 */
export function getSyncBufFilePath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}

export type SyncBufData = {
  get_updates_buf: string;
};

function readSyncBufFile(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    if (typeof data.get_updates_buf === "string") {
      return data.get_updates_buf;
    }
  } catch {
    // file not found or invalid
  }
  return undefined;
}

/**
 * Load persisted get_updates_buf.
 * Falls back to the legacy raw-accountId filename for old installs.
 */
export function loadGetUpdatesBuf(filePath: string): string | undefined {
  const value = readSyncBufFile(filePath);
  if (value !== undefined) return value;

  const accountId = path.basename(filePath, ".sync.json");
  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compatPath = path.join(resolveAccountsDir(), `${rawId}.sync.json`);
    const compatValue = readSyncBufFile(compatPath);
    if (compatValue !== undefined) return compatValue;
  }

  return undefined;
}

/**
 * Persist get_updates_buf. Creates parent dir if needed.
 */
export function saveGetUpdatesBuf(filePath: string, getUpdatesBuf: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}
