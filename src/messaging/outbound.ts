import path from "node:path";

import { resolveWeixinAccount } from "../auth/accounts.js";
import { assertSessionActive } from "../api/session-guard.js";
import { getContextToken, restoreContextTokens } from "./inbound.js";
import { sendMessageWeixin } from "./send.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { resolveTmpDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

const MEDIA_OUTBOUND_TEMP_DIR = path.join(resolveTmpDir(), "media", "outbound");

/** True when mediaUrl refers to a local filesystem path (no URL scheme). */
function isLocalFilePath(mediaUrl: string): boolean {
  return !mediaUrl.includes("://");
}

function isRemoteUrl(mediaUrl: string): boolean {
  return mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
}

/** Resolve any local path scheme to an absolute filesystem path. */
function resolveLocalPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) return new URL(mediaUrl).pathname;
  if (!path.isAbsolute(mediaUrl)) return path.resolve(mediaUrl);
  return mediaUrl;
}

export interface SendResult {
  accountId: string;
  to: string;
  messageId: string;
  /** True when a context token was found and attached. */
  hadContextToken: boolean;
}

/**
 * Send a WeChat message (text and/or a single media attachment) to a user.
 *
 * - `to` is the recipient WeChat id (e.g. `xxxx@im.wechat`).
 * - `media` is an optional local file path or remote http(s) URL.
 * - The per-recipient context token (cached from inbound messages) is attached
 *   automatically when available; sending without it may be rejected for users
 *   who have not recently messaged the bot.
 */
export async function sendWeChatMessage(params: {
  to: string;
  text?: string;
  media?: string;
  accountId?: string | null;
}): Promise<SendResult> {
  const account = resolveWeixinAccount(params.accountId);
  const aLog = logger.withAccount(account.accountId);

  if (!account.configured) {
    throw new Error(
      "wechat: account not configured — run the `wechat_login` tool first",
    );
  }
  assertSessionActive(account.accountId);

  // Make sure cached context tokens from prior sessions are loaded.
  restoreContextTokens(account.accountId);
  const contextToken = getContextToken(account.accountId, params.to);
  if (!contextToken) {
    aLog.warn(`sendWeChatMessage: no context token for to=${params.to}, sending without context`);
  }

  const text = params.text ?? "";
  const media = params.media?.trim();

  if (media && (isLocalFilePath(media) || isRemoteUrl(media))) {
    let filePath: string;
    if (isLocalFilePath(media)) {
      filePath = resolveLocalPath(media);
    } else {
      aLog.debug(`sendWeChatMessage: downloading remote media ${media.slice(0, 80)}...`);
      filePath = await downloadRemoteImageToTemp(media, MEDIA_OUTBOUND_TEMP_DIR);
    }
    const result = await sendWeixinMediaFile({
      filePath,
      to: params.to,
      text,
      opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      cdnBaseUrl: account.cdnBaseUrl,
    });
    return {
      accountId: account.accountId,
      to: params.to,
      messageId: result.messageId,
      hadContextToken: Boolean(contextToken),
    };
  }

  const result = await sendMessageWeixin({
    to: params.to,
    text,
    opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
  });
  return {
    accountId: account.accountId,
    to: params.to,
    messageId: result.messageId,
    hadContextToken: Boolean(contextToken),
  };
}
