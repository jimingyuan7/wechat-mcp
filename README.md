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
| `wechat_send` | Send text and/or a media attachment (image / video / file) to a user. Accepts a local path or a remote http(s) URL. Text is markdown-filtered by default (WeChat-unsupported syntax stripped); pass `filterMarkdown: false` for raw text. |
| `wechat_receive` | Poll for new inbound messages (one long-poll cycle). Tracks a per-account sync cursor so repeated calls don't return duplicates. Inbound media is downloaded + decrypted to local temp files. |
| `wechat_listen` | Continuously poll until a message arrives, an error occurs, or the window elapses (default 2 min). Re-polls back-to-back — the reliable way to wait for a message, since a single `wechat_receive` cycle often returns empty early. |
| `wechat_typing` | Show (or cancel) the "正在输入…" typing indicator for a user. The typing ticket is resolved automatically. |

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

## Usage examples

> In a chat with an MCP client (e.g. Claude Code / Claude Desktop) you just ask
> in natural language — "reply to the last WeChat message", "send this photo to
> the user", etc. The tool-call payloads below show what the client sends under
> the hood, and are also handy for direct/manual testing.

The recommended flow is **receive first, then reply**: an inbound message caches
the `context_token` that outbound sends require.

### 1. See who's logged in

```json
{ "name": "wechat_list_accounts", "arguments": {} }
```

```jsonc
// → result
{ "count": 1, "accounts": [
  { "accountId": "bfa52ff0d915-im-bot",
    "userId": "o9cq...@im.wechat", "configured": true }
] }
```

### 2. Wait for an incoming message (recommended over wechat_receive)

`wechat_listen` re-polls until a message arrives or the window elapses:

```json
{ "name": "wechat_listen", "arguments": { "windowMs": 120000 } }
```

```jsonc
// → result (returns as soon as a message arrives)
{ "messages": [
  { "From": "o9cq...@im.wechat", "Body": "你好",
    "MediaPath": null, "context_token": "AARz..." }
], "pollCycles": 3, "timedOut": false }
```

Copy `From` — that's the `to` you reply to. The `context_token` is now cached,
so the next send will actually deliver.

### 3. Reply with text

```json
{ "name": "wechat_send", "arguments": {
  "to": "o9cq...@im.wechat", "text": "你好！收到了 👍" } }
```

```jsonc
// → result
{ "messageId": "wechat-mcp:...", "hadContextToken": true, "markdownFiltered": false }
```

> `hadContextToken: true` means it will be delivered. If it's `false`, the
> recipient hasn't messaged the bot yet — have them send one message first.

### 4. "Typing…" indicator before a slow reply

```json
{ "name": "wechat_typing", "arguments": { "to": "o9cq...@im.wechat" } }
```

…do your slow work (call an LLM, fetch data), then `wechat_send` the result.
Cancel the indicator early with `{ "to": "...", "status": "cancel" }`.

### 5. Send an image or file

Local path (absolute recommended) or a remote URL — type is auto-detected:

```json
{ "name": "wechat_send", "arguments": {
  "to": "o9cq...@im.wechat", "text": "这是图", "media": "/tmp/photo.png" } }
```

```json
{ "name": "wechat_send", "arguments": {
  "to": "o9cq...@im.wechat", "media": "https://example.com/cat.jpg" } }
```

### 6. Markdown handling

Outbound text is markdown-filtered by default — WeChat-unsupported syntax
(H5/H6 headings, CJK italics `*…*`, inline images) is stripped so users see
clean text instead of stray symbols. Pass `filterMarkdown: false` to send raw:

```json
{ "name": "wechat_send", "arguments": {
  "to": "o9cq...@im.wechat", "text": "raw **markdown** stays", "filterMarkdown": false } }
```

> Note: WeChat chat bubbles do **not** render rich text at all — filtering only
> removes noisy markers; it cannot make text bold/italic on the WeChat side.

### Quick CLI smoke test (no MCP client)

You can drive the server over stdio directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wechat_list_accounts","arguments":{}}}' \
  | node dist/mcp/server.js
```

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
               receive (single cycle + receiveUntil listen loop), outbound (high-level
               send w/ markdown filter), typing (indicator), markdown-filter
  storage/     state-dir resolution + sync-buf (getUpdates cursor) persistence
  util/        logger (STDERR-only), redaction, id/account-id helpers
  mcp/         MCP stdio server exposing the 5 tools
```

The STDOUT stream is reserved exclusively for the MCP JSON-RPC protocol; all
human-facing output (logs, QR codes, prompts) goes to STDERR.

## Credits

Protocol implementation ported from
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT).
