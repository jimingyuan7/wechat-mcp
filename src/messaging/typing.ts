import { getConfig, sendTyping } from "../api/api.js";
import { resolveWeixinAccount } from "../auth/accounts.js";
import { assertSessionActive } from "../api/session-guard.js";
import { getContextToken, restoreContextTokens } from "./inbound.js";
import { TypingStatus } from "../api/types.js";
import { logger } from "../util/logger.js";

export interface TypingResult {
  accountId: string;
  to: string;
  status: "typing" | "cancel";
  /** True when a typing ticket was resolved and attached. */
  hadTypingTicket: boolean;
}

/**
 * Send a typing indicator ("正在输入…") to a WeChat user, or cancel it.
 *
 * The backend requires a per-bot `typing_ticket`, fetched via `getConfig` for
 * the target user (the per-message context token is attached when available).
 */
export async function sendWeChatTyping(params: {
  to: string;
  /** "typing" shows the indicator (default); "cancel" clears it. */
  status?: "typing" | "cancel";
  accountId?: string | null;
}): Promise<TypingResult> {
  const account = resolveWeixinAccount(params.accountId);
  const aLog = logger.withAccount(account.accountId);

  if (!account.configured) {
    throw new Error("wechat: account not configured — run the `wechat_login` tool first");
  }
  assertSessionActive(account.accountId);

  restoreContextTokens(account.accountId);
  const contextToken = getContextToken(account.accountId, params.to);

  // Resolve the typing ticket for this user.
  let typingTicket = "";
  try {
    const cfg = await getConfig({
      baseUrl: account.baseUrl,
      token: account.token,
      ilinkUserId: params.to,
      contextToken,
    });
    if (cfg.ret === 0) {
      typingTicket = cfg.typing_ticket ?? "";
    } else {
      aLog.warn(`sendWeChatTyping: getConfig ret=${cfg.ret} errmsg=${cfg.errmsg ?? ""}`);
    }
  } catch (err) {
    aLog.warn(`sendWeChatTyping: getConfig failed (continuing without ticket): ${String(err)}`);
  }

  const status =
    params.status === "cancel" ? TypingStatus.CANCEL : TypingStatus.TYPING;

  await sendTyping({
    baseUrl: account.baseUrl,
    token: account.token,
    body: {
      ilink_user_id: params.to,
      typing_ticket: typingTicket || undefined,
      status,
    },
  });

  return {
    accountId: account.accountId,
    to: params.to,
    status: params.status === "cancel" ? "cancel" : "typing",
    hadTypingTicket: Boolean(typingTicket),
  };
}
