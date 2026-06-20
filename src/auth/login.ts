import { normalizeAccountId } from "../util/account-id.js";
import {
  DEFAULT_BASE_URL,
  registerWeixinAccountId,
  saveWeixinAccount,
  clearStaleAccountsForUserId,
} from "./accounts.js";
import { clearContextTokensForAccount } from "../messaging/inbound.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
} from "./login-qr.js";
import { logger } from "../util/logger.js";

export interface LoginResult {
  connected: boolean;
  alreadyConnected: boolean;
  accountId?: string;
  message: string;
}

/**
 * Run the interactive QR login flow end-to-end:
 *   1. Fetch a QR code and render it to the terminal (STDERR).
 *   2. Long-poll until the user scans + confirms (or it times out).
 *   3. Persist the resulting bot token / account on success.
 *
 * NOTE: The QR code is rendered to STDERR so this is safe to run while an MCP
 * stdio server owns STDOUT. For first-time setup, run `npm run login`.
 */
export async function runQrLogin(opts?: {
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<LoginResult> {
  const start = await startWeixinLoginWithQr({
    apiBaseUrl: DEFAULT_BASE_URL,
    botType: DEFAULT_ILINK_BOT_TYPE,
    verbose: opts?.verbose,
  });

  if (!start.qrcodeUrl) {
    logger.warn(`runQrLogin: failed to get QR code: ${start.message}`);
    return { connected: false, alreadyConnected: false, message: start.message };
  }

  process.stderr.write("\n用手机微信扫描以下二维码，以继续连接：\n\n");
  await displayQRCode(start.qrcodeUrl);
  process.stderr.write("\n正在等待扫码...\n");

  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
    timeoutMs: opts?.timeoutMs ?? 480_000,
    verbose: opts?.verbose,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (wait.connected && wait.botToken && wait.accountId) {
    const normalizedId = normalizeAccountId(wait.accountId);
    saveWeixinAccount(normalizedId, {
      token: wait.botToken,
      baseUrl: wait.baseUrl,
      userId: wait.userId,
    });
    registerWeixinAccountId(normalizedId);
    if (wait.userId) {
      clearStaleAccountsForUserId(normalizedId, wait.userId, clearContextTokensForAccount);
    }
    logger.info(`runQrLogin: connected accountId=${normalizedId}`);
    return {
      connected: true,
      alreadyConnected: false,
      accountId: normalizedId,
      message: "已将此设备连接到微信。",
    };
  }

  if (wait.alreadyConnected) {
    return {
      connected: false,
      alreadyConnected: true,
      message: "已连接过，无需重复连接。",
    };
  }

  return { connected: false, alreadyConnected: false, message: wait.message };
}
