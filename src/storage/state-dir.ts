import os from "node:os";
import path from "node:path";

/**
 * Resolve the state directory where credentials, sync bufs, and context tokens
 * are persisted. Override with WECHAT_MCP_STATE_DIR; defaults to ~/.wechat-mcp.
 */
export function resolveStateDir(): string {
  return (
    process.env.WECHAT_MCP_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".wechat-mcp")
  );
}

/**
 * Preferred temp dir for transient media (downloads, decrypted inbound media,
 * remote outbound media). Override with WECHAT_MCP_TMP_DIR.
 */
export function resolveTmpDir(): string {
  return (
    process.env.WECHAT_MCP_TMP_DIR?.trim() ||
    path.join(resolveStateDir(), "tmp")
  );
}
