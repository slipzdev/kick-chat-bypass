# kick-chat-bypass

Connect to Kick.com live chat directly from the browser - no server, no Puppeteer, no headless browsers.

A lightweight browser SDK that resolves chatroom IDs and connects to Kick's Pusher WebSocket client-side. Works in any browser environment including OBS browser sources.

Built by [Slipz](https://x.com/slipperrz) for [SlipzTools](https://tools.slipz.net). Client-side rewrite by [@bebiksior](https://github.com/bebiksior).

## The Problem

To read Kick chat, you need to subscribe to a Pusher WebSocket channel called `chatrooms.{chatroom_id}.v2`. Getting that `chatroom_id` is the hard part:

- **Official Kick API** (`api.kick.com`) - does NOT return `chatroom_id`. Only returns `broadcaster_user_id`, which is a different number.
- **Unofficial Kick API** (`kick.com/api/v1/channels/{slug}`) - returns `chatroom.id`, but Cloudflare blocks server-side requests.
- **Puppeteer approach** - uses a headless browser to bypass Cloudflare. Works, but adds ~300MB of dependencies and is slow.

`broadcaster_user_id` != `chatroom_id`:

| Channel | `broadcaster_user_id` | `chatroom_id` |
|---------|----------------------|---------------|
| xqc     | 676                  | 668           |

Subscribing to `chatrooms.676.v2` gives you nothing. You need `chatrooms.668.v2`.

## The Solution

Skip the server entirely. The browser can fetch from `kick.com` directly (no CORS issues in browser context), resolve the chatroom ID, and connect to Pusher - all client-side.

```
Browser
  |
  |-- fetch kick.com/api/v1/channels/xqc --> { chatroom: { id: 668 } }
  |
  |-- connect wss://ws-us2.pusher.com/...
  |-- subscribe chatrooms.668.v2
  |
  |<-- ChatMessageEvent { sender: "user", content: "hello" }
```

No server to maintain, no cache to poison, no proxy to DDoS.

## Quick Start

```bash
git clone https://github.com/slipzdev/kick-chat-bypass.git
cd kick-chat-bypass
npm start
```

Open `http://localhost:3000` in your browser. Type a channel name and hit Connect.

## Usage

Include the SDK and create a connection:

```html
<script src="kick-chat.js"></script>
<script>
  const chat = new KickChat('xqc')

  chat.on('connected', ({ chatroomId }) => {
    console.log('connected to chatroom', chatroomId)
  })

  chat.on('message', ({ author, text, color, raw }) => {
    console.log(`${author}: ${text}`)
  })

  chat.on('error', ({ message }) => {
    console.error(message)
  })

  chat.on('status', ({ state }) => {
    // 'resolving' | 'reconnecting'
    console.log('status:', state)
  })

  chat.on('disconnected', () => {
    console.log('disconnected')
  })

  chat.connect()

  // later: chat.disconnect()
</script>
```

## Events

| Event | Data | Description |
|-------|------|-------------|
| `connected` | `{ chatroomId }` | Successfully subscribed to the chat channel |
| `message` | `{ author, text, color, raw }` | Chat message received. `raw` contains the full Kick payload |
| `error` | `{ message }` | Connection or resolution error |
| `status` | `{ state }` | Status changes: `resolving`, `reconnecting` |
| `disconnected` | `{}` | Clean disconnect after calling `disconnect()` |

## How It Works

1. `KickChat` fetches the channel data from `kick.com/api/v1/channels/{slug}` (falls back to v2)
2. Extracts `chatroom.id` from the response
3. Opens a WebSocket to Kick's Pusher endpoint (`wss://ws-us2.pusher.com/app/...`)
4. Subscribes to `chatrooms.{id}.v2`
5. Parses incoming `ChatMessageEvent` messages and emits them as `message` events
6. Sends keepalive pings every 30s to prevent Pusher from dropping the connection
7. Auto-reconnects on disconnect (3s delay)

## License

MIT
