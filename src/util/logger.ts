/**
 * Lightweight logger for the WeChat MCP server.
 *
 * Writes to STDERR only — never STDOUT, because an MCP stdio server uses
 * STDOUT exclusively for the JSON-RPC protocol stream. Anything printed to
 * STDOUT would corrupt the protocol.
 *
 * Level is controlled by the WECHAT_MCP_LOG_LEVEL env var (default INFO).
 */

const LEVEL_IDS: Record<string, number> = {
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ERROR: 5,
  FATAL: 6,
};

const DEFAULT_LOG_LEVEL = "INFO";

function resolveMinLevel(): number {
  const env = process.env.WECHAT_MCP_LOG_LEVEL?.toUpperCase();
  if (env && env in LEVEL_IDS) return LEVEL_IDS[env];
  return LEVEL_IDS[DEFAULT_LOG_LEVEL];
}

let minLevelId = resolveMinLevel();

export function setLogLevel(level: string): void {
  const upper = level.toUpperCase();
  if (!(upper in LEVEL_IDS)) {
    throw new Error(
      `Invalid log level: ${level}. Valid levels: ${Object.keys(LEVEL_IDS).join(", ")}`,
    );
  }
  minLevelId = LEVEL_IDS[upper];
}

export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Returns a child logger whose messages are prefixed with `[accountId]`. */
  withAccount(accountId: string): Logger;
};

function writeLog(level: string, message: string, accountId?: string): void {
  const levelId = LEVEL_IDS[level] ?? LEVEL_IDS.INFO;
  if (levelId < minLevelId) return;

  const ts = new Date().toISOString();
  const prefix = accountId ? `[${accountId}] ` : "";
  // STDERR only — keep STDOUT clean for the MCP JSON-RPC stream.
  process.stderr.write(`${ts} ${level.padEnd(5)} wechat-mcp ${prefix}${message}\n`);
}

function createLogger(accountId?: string): Logger {
  return {
    info(message: string): void {
      writeLog("INFO", message, accountId);
    },
    debug(message: string): void {
      writeLog("DEBUG", message, accountId);
    },
    warn(message: string): void {
      writeLog("WARN", message, accountId);
    },
    error(message: string): void {
      writeLog("ERROR", message, accountId);
    },
    withAccount(id: string): Logger {
      return createLogger(id);
    },
  };
}

export const logger: Logger = createLogger();
