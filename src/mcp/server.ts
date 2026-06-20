#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  listWeixinAccountIds,
  loadWeixinAccount,
  resolveWeixinAccount,
  clearWeixinAccount,
  unregisterWeixinAccountId,
} from "../auth/accounts.js";
import { clearContextTokensForAccount } from "../messaging/inbound.js";
import { runQrLogin } from "../auth/login.js";
import { sendWeChatMessage } from "../messaging/outbound.js";
import { receiveOnce, receiveUntil } from "../messaging/receive.js";
import { sendWeChatTyping } from "../messaging/typing.js";
import { logger } from "../util/logger.js";

const SERVER_NAME = "wechat-mcp";
const SERVER_VERSION = "0.2.0";

/** Wrap a result object as an MCP text content block of pretty JSON. */
function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // -------------------------------------------------------------------------
  // wechat_list_accounts
  // -------------------------------------------------------------------------
  server.registerTool(
    "wechat_list_accounts",
    {
      title: "List WeChat accounts",
      description:
        "List all WeChat (Weixin) bot accounts that have been logged in via QR code. Returns each account id, base URL, and whether it has a valid token.",
      inputSchema: {},
    },
    async () => {
      const ids = listWeixinAccountIds();
      const accounts = ids.map((id) => {
        const data = loadWeixinAccount(id);
        return {
          accountId: id,
          baseUrl: data?.baseUrl ?? null,
          userId: data?.userId ?? null,
          configured: Boolean(data?.token),
          savedAt: data?.savedAt ?? null,
        };
      });
      return jsonResult({ count: accounts.length, accounts });
    },
  );

  // -------------------------------------------------------------------------
  // wechat_login
  // -------------------------------------------------------------------------
  server.registerTool(
    "wechat_login",
    {
      title: "Log in to WeChat via QR code",
      description:
        "Start an interactive WeChat login. A QR code is printed to the server's STDERR/terminal; scan it with the WeChat mobile app and confirm. Blocks until login completes or times out. For first-time setup it is usually easier to run `npm run login` in a real terminal. Returns the connected account id on success.",
      inputSchema: {
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max time to wait for the QR scan (default 480000 = 8 min)."),
      },
    },
    async ({ timeoutMs }) => {
      try {
        const result = await runQrLogin({ timeoutMs, verbose: false });
        return jsonResult(result);
      } catch (err) {
        return errorResult(`wechat_login failed: ${String(err)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // wechat_logout
  // -------------------------------------------------------------------------
  server.registerTool(
    "wechat_logout",
    {
      title: "Log out / remove a WeChat account",
      description:
        "Remove a logged-in WeChat account: deletes its stored credentials, sync buffer, and cached context tokens. Provide the accountId from wechat_list_accounts.",
      inputSchema: {
        accountId: z.string().min(1).describe("Account id to remove (see wechat_list_accounts)."),
      },
    },
    async ({ accountId }) => {
      try {
        clearContextTokensForAccount(accountId);
        clearWeixinAccount(accountId);
        unregisterWeixinAccountId(accountId);
        return jsonResult({ removed: true, accountId });
      } catch (err) {
        return errorResult(`wechat_logout failed: ${String(err)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // wechat_send
  // -------------------------------------------------------------------------
  server.registerTool(
    "wechat_send",
    {
      title: "Send a WeChat message",
      description:
        "Send a WeChat message to a user. Provide `to` (the recipient WeChat id, e.g. 'xxxx@im.wechat'), and `text` and/or `media`. `media` may be a local file path (absolute recommended) or a remote http(s) URL — images, videos, and other files are auto-detected by extension. If multiple accounts are logged in, pass `accountId`. The per-recipient context token (cached from inbound messages) is attached automatically when available. Outbound text is markdown-filtered by default (WeChat-unsupported syntax such as H5/H6 headings, CJK italics, and inline images is stripped; code blocks, tables, and bold are kept).",
      inputSchema: {
        to: z.string().min(1).describe("Recipient WeChat id, e.g. 'xxxx@im.wechat'."),
        text: z.string().optional().describe("Message text. Optional when sending media only."),
        media: z
          .string()
          .optional()
          .describe("Local file path or remote http(s) URL for an image/video/file attachment."),
        accountId: z
          .string()
          .optional()
          .describe("Sending account id; required only when multiple accounts are logged in."),
        filterMarkdown: z
          .boolean()
          .optional()
          .describe("Strip WeChat-unsupported markdown from text (default true). Set false to send raw text."),
      },
    },
    async ({ to, text, media, accountId, filterMarkdown }) => {
      if (!text && !media) {
        return errorResult("wechat_send requires at least one of `text` or `media`.");
      }
      try {
        const result = await sendWeChatMessage({
          to,
          text,
          media,
          accountId,
          filterMarkdownText: filterMarkdown,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(`wechat_send failed: ${String(err)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // wechat_receive
  // -------------------------------------------------------------------------
  server.registerTool(
    "wechat_receive",
    {
      title: "Receive WeChat messages",
      description:
        "Poll for new inbound WeChat messages (one long-poll cycle). Returns messages received since the last poll; the server tracks a per-account sync cursor so repeated calls do not return duplicates. Media (images/voice/files/video) is downloaded and decrypted to local temp files by default, with the path returned in `MediaPath`. If multiple accounts are logged in, pass `accountId`.",
      inputSchema: {
        accountId: z
          .string()
          .optional()
          .describe("Account id to poll; required only when multiple accounts are logged in."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Long-poll timeout in ms (default 35000). The server holds the request open up to this long waiting for new messages."),
        downloadMedia: z
          .boolean()
          .optional()
          .describe("Download + decrypt inbound media to temp files (default true)."),
      },
    },
    async ({ accountId, timeoutMs, downloadMedia }) => {
      try {
        const account = resolveWeixinAccount(accountId);
        if (!account.configured) {
          return errorResult(
            `wechat_receive: account ${account.accountId} not configured — run wechat_login first`,
          );
        }
        const result = await receiveOnce({ account, timeoutMs, downloadMedia });
        return jsonResult(result);
      } catch (err) {
        return errorResult(`wechat_receive failed: ${String(err)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // wechat_listen
  // -------------------------------------------------------------------------
  server.registerTool(
    "wechat_listen",
    {
      title: "Listen for WeChat messages",
      description:
        "Continuously poll until at least one inbound message arrives, an error occurs, or the listen window elapses. Unlike wechat_receive (a single poll cycle that often returns empty immediately), this re-polls back-to-back across the whole window — the correct way to wait for a message. Returns as soon as a message is received, with `pollCycles` and `timedOut` for diagnostics. Media is downloaded + decrypted to local temp files by default. If multiple accounts are logged in, pass `accountId`.",
      inputSchema: {
        accountId: z
          .string()
          .optional()
          .describe("Account id to listen on; required only when multiple accounts are logged in."),
        windowMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Total time to keep listening, in ms (default 120000 = 2 min)."),
        cycleTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Per-cycle long-poll timeout, in ms (default 30000)."),
        downloadMedia: z
          .boolean()
          .optional()
          .describe("Download + decrypt inbound media to temp files (default true)."),
      },
    },
    async ({ accountId, windowMs, cycleTimeoutMs, downloadMedia }) => {
      try {
        const account = resolveWeixinAccount(accountId);
        if (!account.configured) {
          return errorResult(
            `wechat_listen: account ${account.accountId} not configured — run wechat_login first`,
          );
        }
        const result = await receiveUntil({
          account,
          windowMs,
          cycleTimeoutMs,
          downloadMedia,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(`wechat_listen failed: ${String(err)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // wechat_typing
  // -------------------------------------------------------------------------
  server.registerTool(
    "wechat_typing",
    {
      title: "Send a WeChat typing indicator",
      description:
        "Show (or cancel) the '正在输入…' typing indicator to a WeChat user. Useful before a slow reply so the user sees the bot is working. The required typing ticket is resolved automatically. If multiple accounts are logged in, pass `accountId`.",
      inputSchema: {
        to: z.string().min(1).describe("Recipient WeChat id, e.g. 'xxxx@im.wechat'."),
        status: z
          .enum(["typing", "cancel"])
          .optional()
          .describe("'typing' to show the indicator (default), 'cancel' to clear it."),
        accountId: z
          .string()
          .optional()
          .describe("Sending account id; required only when multiple accounts are logged in."),
      },
    },
    async ({ to, status, accountId }) => {
      try {
        const result = await sendWeChatTyping({ to, status, accountId });
        return jsonResult(result);
      } catch (err) {
        return errorResult(`wechat_typing failed: ${String(err)}`);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  // Subcommand: `wechat-mcp login` runs the interactive QR login and exits.
  const arg = process.argv[2];
  if (arg === "login") {
    const result = await runQrLogin({ verbose: true });
    process.stderr.write(`\n${result.message}\n`);
    process.exit(result.connected || result.alreadyConnected ? 0 : 1);
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("wechat-mcp server started (stdio)");
}

main().catch((err) => {
  logger.error(`fatal: ${String(err)}`);
  process.stderr.write(`wechat-mcp fatal: ${String(err)}\n`);
  process.exit(1);
});
