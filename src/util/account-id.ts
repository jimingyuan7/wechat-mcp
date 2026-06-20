/**
 * Normalize a raw iLink bot/user id into a filesystem-safe account id.
 *
 * The WeChat backend issues ids like `b0f5860fdecb@im.bot` or
 * `abc123@im.wechat`. We replace the special chars (`@`, `.`) with `-` so the
 * id can be used directly as a filename, e.g. `b0f5860fdecb-im-bot`.
 *
 * This mirrors the behavior of openclaw's `plugin-sdk/account-id`
 * `normalizeAccountId`, kept local so the MCP server has no OpenClaw runtime
 * dependency.
 */
export function normalizeAccountId(raw: string): string {
  return raw
    .trim()
    .replace(/[@.]/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "-");
}
