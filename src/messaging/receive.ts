import fs from "node:fs/promises";
import path from "node:path";

import { getUpdates } from "../api/api.js";
import { resolveTmpDir } from "../storage/state-dir.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import {
  setContextToken,
  restoreContextTokens,
  weixinMessageToMsgContext,
  isMediaItem,
} from "./inbound.js";
import type { WeixinMsgContext } from "./inbound.js";
import type { ResolvedWeixinAccount } from "../auth/accounts.js";
import type { WeixinMessage } from "../api/types.js";
import { SESSION_EXPIRED_ERRCODE } from "../api/session-guard.js";
import { logger } from "../util/logger.js";
import { tempFileName } from "../util/random.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

export interface ReceivedMessage extends WeixinMsgContext {
  /** Raw item types present on the message (for debugging). */
  itemTypes: number[];
}

export interface ReceiveResult {
  accountId: string;
  /** Normalized inbound messages. */
  messages: ReceivedMessage[];
  /** True when the server reported the session expired (re-login required). */
  sessionExpired: boolean;
  /** API error info, if any. */
  error?: { ret?: number; errcode?: number; errmsg?: string };
}

/**
 * Persist a downloaded media buffer to the temp dir and return its path.
 * Replaces the OpenClaw framework media store with a plain temp-file writer.
 */
async function saveMediaToTmp(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
  _maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(resolveTmpDir(), "media", subdir);
  await fs.mkdir(dir, { recursive: true });
  let name: string;
  if (originalFilename) {
    name = `${Date.now()}-${originalFilename}`;
  } else {
    const ext = guessExt(contentType);
    name = tempFileName("wechat-inbound", ext);
  }
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

function guessExt(contentType?: string): string {
  if (!contentType) return ".bin";
  if (contentType.startsWith("image/")) return "." + (contentType.split("/")[1] || "img");
  if (contentType === "audio/wav") return ".wav";
  if (contentType === "audio/silk") return ".silk";
  if (contentType.startsWith("video/")) return ".mp4";
  return ".bin";
}

/**
 * Perform a single getUpdates long-poll cycle for one account:
 *   1. Restore context tokens + sync buf from disk.
 *   2. Long-poll getUpdates once.
 *   3. Persist the new sync buf and context tokens.
 *   4. Optionally download + decrypt inbound media to the temp dir.
 *   5. Return normalized messages.
 *
 * This is the MCP-friendly equivalent of the OpenClaw monitor loop — one cycle
 * per call instead of an infinite background loop.
 */
export async function receiveOnce(params: {
  account: ResolvedWeixinAccount;
  timeoutMs?: number;
  downloadMedia?: boolean;
  abortSignal?: AbortSignal;
}): Promise<ReceiveResult> {
  const { account } = params;
  const aLog = logger.withAccount(account.accountId);
  const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const downloadMedia = params.downloadMedia !== false;

  restoreContextTokens(account.accountId);

  const syncFilePath = getSyncBufFilePath(account.accountId);
  const getUpdatesBuf = loadGetUpdatesBuf(syncFilePath) ?? "";

  const resp = await getUpdates({
    baseUrl: account.baseUrl,
    token: account.token,
    get_updates_buf: getUpdatesBuf,
    timeoutMs,
    abortSignal: params.abortSignal,
  });

  const isApiError =
    (resp.ret !== undefined && resp.ret !== 0) ||
    (resp.errcode !== undefined && resp.errcode !== 0);

  if (isApiError) {
    const sessionExpired =
      resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
    aLog.error(
      `receiveOnce: getUpdates failed ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`,
    );
    return {
      accountId: account.accountId,
      messages: [],
      sessionExpired,
      error: { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg },
    };
  }

  // Persist the new sync buf so the next poll only returns newer messages.
  if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
    saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
  }

  const list = resp.msgs ?? [];
  const messages: ReceivedMessage[] = [];

  for (const msg of list) {
    const fromUserId = msg.from_user_id ?? "";
    // Cache the per-message context token so wechat_send can echo it back.
    if (msg.context_token && fromUserId) {
      setContextToken(account.accountId, fromUserId, msg.context_token);
    }

    let mediaOpts = undefined as Awaited<ReturnType<typeof downloadMediaFromItem>> | undefined;
    if (downloadMedia) {
      mediaOpts = await downloadFirstMedia(msg, account.cdnBaseUrl, aLog);
    }

    const ctx = weixinMessageToMsgContext(msg, account.accountId, mediaOpts);
    messages.push({
      ...ctx,
      itemTypes: msg.item_list?.map((i) => i.type ?? 0) ?? [],
    });
  }

  aLog.info(`receiveOnce: ${messages.length} message(s)`);
  return { accountId: account.accountId, messages, sessionExpired: false };
}

export interface ListenResult extends ReceiveResult {
  /** Number of getUpdates cycles performed before returning. */
  pollCycles: number;
  /** True when the listen window elapsed without any message. */
  timedOut: boolean;
}

/**
 * Continuously poll until at least one message arrives, an API error occurs,
 * or the overall deadline is reached.
 *
 * `receiveOnce` does a single getUpdates cycle, and the backend frequently
 * returns an empty response well before the requested long-poll timeout — so a
 * single call can return immediately with nothing. This loop re-polls back to
 * back, which is the correct way to "listen" for a message over a window.
 */
export async function receiveUntil(params: {
  account: ResolvedWeixinAccount;
  /** Total time to keep listening, ms (default 120000 = 2 min). */
  windowMs?: number;
  /** Per-cycle long-poll timeout, ms (default 30000). */
  cycleTimeoutMs?: number;
  downloadMedia?: boolean;
  abortSignal?: AbortSignal;
}): Promise<ListenResult> {
  const { account } = params;
  const windowMs = params.windowMs ?? 120_000;
  const cycleTimeoutMs = params.cycleTimeoutMs ?? 30_000;
  const deadline = Date.now() + windowMs;

  let pollCycles = 0;
  let last: ReceiveResult = { accountId: account.accountId, messages: [], sessionExpired: false };

  while (Date.now() < deadline && !params.abortSignal?.aborted) {
    // Clamp the final cycle so we don't overshoot the window by much.
    const remaining = deadline - Date.now();
    const thisCycle = Math.max(1_000, Math.min(cycleTimeoutMs, remaining));

    last = await receiveOnce({
      account,
      timeoutMs: thisCycle,
      downloadMedia: params.downloadMedia,
      abortSignal: params.abortSignal,
    });
    pollCycles += 1;

    // Stop early on messages or a hard error (e.g. session expired).
    if (last.messages.length > 0 || last.error || last.sessionExpired) {
      return { ...last, pollCycles, timedOut: false };
    }
  }

  return { ...last, pollCycles, timedOut: true };
}

/**
 * Download + decrypt the first media item on a message (image > video > file >
 * voice priority is enforced downstream by weixinMessageToMsgContext).
 */
async function downloadFirstMedia(
  msg: WeixinMessage,
  cdnBaseUrl: string,
  aLog: ReturnType<typeof logger.withAccount>,
): Promise<Awaited<ReturnType<typeof downloadMediaFromItem>>> {
  let merged: Awaited<ReturnType<typeof downloadMediaFromItem>> = {};
  for (const item of msg.item_list ?? []) {
    if (!isMediaItem(item)) continue;
    const part = await downloadMediaFromItem(item, {
      cdnBaseUrl,
      saveMedia: saveMediaToTmp,
      log: (m) => aLog.debug(m),
      errLog: (m) => aLog.error(m),
      label: "receive",
    });
    merged = { ...merged, ...part };
  }
  return merged;
}
