# kick-chat-serverside

Connect to Kick.com live chat server-side with Node.js - no Puppeteer needed.

Most Kick chat libraries rely on Puppeteer to bypass Cloudflare, which is slow and heavy. This project uses a lightweight two-step approach: a web client resolves the chatroom ID once (bypassing Cloudflare via the browser), the server caches it, and connects directly to Kick's Pusher WebSocket.

Built by [Slipz](https://x.com/slipperrz) for [SlipzTools](https://tools.slipz.net).

## The Problem

To read Kick chat, you need to subscribe to a Pusher WebSocket channel called `chatrooms.{chatroom_id}.v2`. Getting that `chatroom_id` is the hard part:

- **Official Kick API** (`api.kick.com/public/v1/channels?slug=...`) - works from servers, but does NOT return `chatroom_id`. It only returns `broadcaster_user_id`, which is a **different number**.
- **Unofficial Kick API** (`kick.com/api/v1/channels/{slug}`) - returns `chatroom.id`, but Cloudflare blocks requests from servers.
- **Puppeteer approach** - uses a headless browser to bypass Cloudflare. Works, but adds ~300MB of dependencies and is slow to start.

### The gotcha that'll waste your time

`broadcaster_user_id` is NOT the same as `chatroom_id`. For example:

| Channel | `broadcaster_user_id` | `chatroom_id` |
|---------|----------------------|---------------|
| xqc     | 676                  | 668           |

If you subscribe to `chatrooms.676.v2` for xqc, you'll get zero messages. You need `chatrooms.668.v2`. I burned hours on this.

## The Solution

A two-step approach:

```
Browser Client                    Your Server                     Kick Pusher
     |                                |                               |
     |--- WS connect /chat/xqc ----->|                               |
     |                                |-- check cache for chatroom_id |
     |                                |   (miss)                      |
     |<-- need_chatroom_id -----------|                               |
     |                                |                               |
     |-- fetch kick.com/api/v1/ ----->| (browser ignores CORS)       |
     |<-- { chatroom: { id: 668 } }  |                               |
     |                                |                               |
     |--- { chatroom_id: 668 } ----->|                               |
     |                                |-- cache 668                   |
     |                                |-- connect to Pusher --------->|
     |                                |<-- subscribe chatrooms.668.v2 |
     |                                |                               |
     |                                |<-- ChatMessageEvent ----------|
     |<-- { type: message, ... } -----|                               |
```

After the first connection, the chatroom ID is cached. All future clients (even regular browsers that can't bypass CORS) get instant connections.

## Quick Start

```bash
git clone https://github.com/Saltyq/kick-chat-serverside.git
cd kick-chat-serverside
npm install
npm start
```

Open `http://localhost:3000` in your browser. Type a channel name and hit Connect.

**Note:** The chatroom ID resolution requires a browser that can fetch from `kick.com` (CORS). OBS browser sources work perfectly. Regular browsers may be blocked by CORS on the first connection, but once the ID is cached server-side, everything works.

## WebSocket Protocol

### Client -> Server

Connect to `ws://localhost:3000/chat/{channel_slug}`

The server may ask you to resolve the chatroom ID:

```json
{ "type": "need_chatroom_id" }
```

Respond with:

```json
{ "type": "chatroom_id", "id": 668 }
```

### Server -> Client

**Connection established:**
```json
{ "type": "connected", "chatroomId": 668 }
```

**Chat message:**
```json
{
  "type": "message",
  "author": "someuser",
  "text": "hello chat",
  "color": "#FF0000"
}
```

**Error:**
```json
{ "type": "error", "message": "something went wrong" }
```