# wechat-mcp

A **Model Context Protocol (MCP) server** for sending and receiving WeChat
(Weixin) messages, built on Tencent's iLink bot protocol.

This is a port of the messaging core of
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (an
OpenClaw channel plugin) into a standalone MCP server usable from Claude Code,
Claude Desktop, or any MCP client. The WeChat protocol logic — QR login, the
`getUpdates` long-poll receive loop, `sendMessage`, and the AES-128-ECB CDN
media pipeline — is preserved; the OpenClaw runtime/SDK coupling has been
removed and replaced with a thin MCP tool layer.

## What it does

| MCP tool | Purpose |
|---|---|
| `wechat_login` | QR-code login. Prints a QR to the terminal (STDERR); scan with WeChat mobile and confirm. Persists the bot token. |
| `wechat_list_accounts` | List logged-in WeChat bot accounts. |
| `wechat_logout` | Remove an account's stored credentials, sync cursor, and context tokens. |
| `wechat_send` | Send text and/or a media attachment (image / video / file) to a user. Accepts a local path or a remote http(s) URL. |
| `wechat_receive` | Poll for new inbound messages (one long-poll cycle). Tracks a per-account sync cursor so repeated calls don't return duplicates. Inbound media is downloaded + decrypted to local temp files. |

## Requirements

- Node.js >= 20
- A WeChat (Weixin) mobile app to scan the login QR code

## Install

Clone and install. The `prepare` hook compiles TypeScript to `dist/`
automatically on `npm install`, so there is no separate build step.

```bash
git clone <REPO_URL> wechat-mcp
cd wechat-mcp
npm install
```

To rebuild after editing source: `npm run build`.

Optional: voice-message transcoding (SILK → WAV) requires the optional
`silk-wasm` package. Without it, inbound voice is saved as raw `.silk`.

```bash
npm install silk-wasm
```

## First-time login

Run the interactive login in a real terminal (the QR renders to STDERR):

```bash
npm run login
```

Scan the QR code with the WeChat mobile app and confirm. Credentials are saved
under `~/.wechat-mcp/openclaw-weixin/accounts/`.

You can also trigger login through the `wechat_login` MCP tool, but a real
terminal is friendlier for scanning the QR.

## Register with an MCP client

### Claude Code

```bash
claude mcp add wechat -- node /absolute/path/to/wechat-mcp/dist/mcp/server.js
```

### Claude Desktop (`claude_desktop_config.json`)

```jsonc
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["/absolute/path/to/wechat-mcp/dist/mcp/server.js"]
    }
  }
}
```

## Usage notes

- **Recipient ids** look like `xxxxxxxx@im.wechat`. You normally obtain one
  from an inbound message (`wechat_receive` → message `From`).
- **Context tokens**: the WeChat backend issues a per-conversation
  `context_token` on each inbound message that must be echoed on outbound sends.
  The server caches these automatically (in memory + on disk) as messages
  arrive, so `wechat_send` to a user who has recently messaged the bot "just
  works". Sending to a user with no cached token may be rejected by the
  backend.
- **Receiving** is poll-based: call `wechat_receive` repeatedly (e.g. in a
  loop). Each call holds the connection open up to `timeoutMs` (default 35s)
  waiting for new messages, then returns. The sync cursor is persisted, so you
  never see the same message twice across calls or restarts.
- **Media**: outbound media is auto-classified by file extension
  (`video/*`, `image/*`, else generic file). Inbound media is downloaded,
  AES-128-ECB decrypted, and written to `~/.wechat-mcp/tmp/media/inbound/`;
  the local path comes back in the message's `MediaPath`.

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `WECHAT_MCP_STATE_DIR` | `~/.wechat-mcp` | Where credentials, sync cursors, and context tokens are stored. |
| `WECHAT_MCP_TMP_DIR` | `<state>/tmp` | Temp dir for downloaded / decrypted media. |
| `WECHAT_MCP_LOG_LEVEL` | `INFO` | `TRACE` `DEBUG` `INFO` `WARN` `ERROR`. Logs go to STDERR. |
| `WECHAT_MCP_BOT_AGENT` | `WeChatMCP` | UA-style self-identifier sent on every request (for backend log attribution). |
| `WECHAT_MCP_CDN_BASE_URL` | Tencent C2C CDN | Override the media CDN base. |
| `WECHAT_MCP_ROUTE_TAG` | — | Optional `SKRouteTag` header. |

## Architecture

```
src/
  api/         iLink HTTP+JSON protocol (getUpdates, sendMessage, getUploadUrl, …) + types
  auth/        QR login flow + per-account credential store
  cdn/         AES-128-ECB encrypt/decrypt + CDN upload/download
  media/       MIME mapping, media download/decrypt, optional SILK→WAV transcode
  messaging/   send (text/image/video/file), inbound normalization + context tokens,
               receive (single poll cycle), outbound (high-level send)
  storage/     state-dir resolution + sync-buf (getUpdates cursor) persistence
  util/        logger (STDERR-only), redaction, id/account-id helpers
  mcp/         MCP stdio server exposing the 5 tools
```

The STDOUT stream is reserved exclusively for the MCP JSON-RPC protocol; all
human-facing output (logs, QR codes, prompts) goes to STDERR.

## Credits

Protocol implementation ported from
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT).
