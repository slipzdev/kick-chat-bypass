// kick-chat-serverside
// connects to kick.com live chat via pusher websocket and forwards messages
// to browser clients over a local websocket. no puppeteer, no heavy deps.
//
// the tricky part: getting the chatroom_id. kick's official API doesn't
// return it, and cloudflare blocks the unofficial API from servers.
// so we ask the browser client to resolve it for us (OBS browser sources
// ignore CORS), then cache it for future connections.
//
// author: slipperrz (x.com/slipperrz)

import express from 'express';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const server = createServer(app);

// ---- pusher config ----
// this is kick's public pusher app key. it's hardcoded in their frontend JS.
const PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const PUSHER_WS_URL = `wss://ws-us2.pusher.com/app/${PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
const PUSHER_PING_INTERVAL = 30000; // 30s keepalive (pusher drops idle connections after ~120s)

// ---- chatroom id cache ----
// in production you'd use redis or similar. for this example, in-memory is fine.
// chatroom IDs don't change, so even a long TTL is safe.
const chatroomCache = new Map(); // slug -> chatroom_id

// ---- session tracking ----
// one pusher connection per kick channel, shared across all browser clients
// watching the same channel. saves resources when multiple overlays are open.
const sessions = new Map(); // slug -> session object

// ---- websocket server ----
const wss = new WebSocketServer({ noServer: true });

// route websocket upgrades by path
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/chat\/([a-zA-Z0-9_-]{1,25})$/);

  if (!match) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    handleConnection(ws, match[1].toLowerCase());
  });
});

// ---- connection handler ----
// when a browser client connects, we either:
// 1. use a cached chatroom_id to connect to pusher immediately
// 2. ask the client to resolve the chatroom_id for us (CORS workaround)

async function handleConnection(ws, slug) {
  let session = sessions.get(slug);
  if (!session) {
    session = {
      clients: new Set(),
      chatroomId: null,
      pusherWs: null,
      reconnectTimer: null,
      pingTimer: null,
    };
    sessions.set(slug, session);
  }

  session.clients.add(ws);
  console.log(`[${slug}] client connected (${session.clients.size} total)`);

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[${slug}] client disconnected (${session.clients.size} remaining)`);
    if (session.clients.size === 0) {
      teardown(slug, session);
    }
  });

  ws.on('error', () => {
    session.clients.delete(ws);
  });

  // the client might send us a chatroom_id it resolved from kick.com
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'chatroom_id' && typeof msg.id === 'number' && msg.id > 0) {
        onChatroomResolved(slug, session, msg.id);
      }
    } catch {
      // ignore malformed messages
    }
  });

  // already connected to pusher? new client just piggybacks
  if (session.pusherWs) return;

  // check cache
  const cached = chatroomCache.get(slug);
  if (cached) {
    console.log(`[${slug}] using cached chatroom_id: ${cached}`);
    onChatroomResolved(slug, session, cached);
    return;
  }

  // no cached value - ask the client to resolve it
  // this works in OBS browser sources (CEF ignores CORS)
  // regular browsers will fail the fetch, but that's expected
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'need_chatroom_id' }));
  }
}

// ---- chatroom id resolved ----
function onChatroomResolved(slug, session, chatroomId) {
  if (session.chatroomId === chatroomId && session.pusherWs) return;

  session.chatroomId = chatroomId;
  chatroomCache.set(slug, chatroomId);
  console.log(`[${slug}] chatroom_id resolved: ${chatroomId}`);

  connectPusher(slug, session);
}

// ---- pusher connection ----
function connectPusher(slug, session) {
  // clean up old connection if any
  if (session.pusherWs) {
    try { session.pusherWs.close(); } catch {}
    session.pusherWs = null;
  }
  if (session.pingTimer) {
    clearInterval(session.pingTimer);
    session.pingTimer = null;
  }

  const chatroomId = session.chatroomId;
  if (!chatroomId) return;

  console.log(`[${slug}] connecting to pusher (chatroom ${chatroomId})`);
  const pusherWs = new WebSocket(PUSHER_WS_URL);
  session.pusherWs = pusherWs;

  pusherWs.on('open', () => {
    console.log(`[${slug}] pusher connected`);

    // subscribe to the chatroom channel
    pusherWs.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${chatroomId}.v2` },
    }));

    // keep-alive pings so pusher doesn't drop us
    session.pingTimer = setInterval(() => {
      if (pusherWs.readyState === WebSocket.OPEN) {
        pusherWs.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, PUSHER_PING_INTERVAL);
  });

  pusherWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // pusher protocol noise - ignore these
      if (msg.event === 'pusher:pong' ||
          msg.event === 'pusher:connection_established') {
        return;
      }

      if (msg.event === 'pusher_internal:subscription_succeeded') {
        console.log(`[${slug}] subscribed to chatroom ${chatroomId}`);
        broadcast(session, { type: 'connected', chatroomId });
        return;
      }

      // respond to pusher pings
      if (msg.event === 'pusher:ping') {
        pusherWs.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        return;
      }

      // ---- IMPORTANT ----
      // the event name is ChatMessageEvent, NOT ChatMessageSentEvent.
      // this tripped us up for a while. kick changed it at some point.
      if (msg.event === 'App\\Events\\ChatMessageEvent' ||
          msg.event === 'App\\Events\\ChatMessageSentEvent') {
        const chatData = JSON.parse(msg.data);
        const username = chatData.sender?.username || chatData.sender?.slug || 'Anonymous';
        const content = chatData.content || '';
        const color = chatData.sender?.identity?.color || null;

        broadcast(session, {
          type: 'message',
          author: username,
          text: content,
          color,
        });
      }
    } catch {
      // malformed pusher message, skip
    }
  });

  pusherWs.on('close', () => {
    console.log(`[${slug}] pusher disconnected`);
    if (session.pingTimer) {
      clearInterval(session.pingTimer);
      session.pingTimer = null;
    }
    session.pusherWs = null;

    // auto-reconnect if clients are still listening
    if (session.clients.size > 0 && session.chatroomId) {
      session.reconnectTimer = setTimeout(() => connectPusher(slug, session), 3000);
    }
  });

  pusherWs.on('error', (err) => {
    console.error(`[${slug}] pusher error:`, err.message);
    try { pusherWs.close(); } catch {}
  });
}

// ---- helpers ----

function broadcast(session, data) {
  const payload = JSON.stringify(data);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function teardown(slug, session) {
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  if (session.pingTimer) clearInterval(session.pingTimer);
  if (session.pusherWs) {
    try { session.pusherWs.close(); } catch {}
  }
  sessions.delete(slug);
  console.log(`[${slug}] session torn down`);
}

// ---- serve the demo page ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

server.listen(PORT, () => {
  console.log(`kick-chat-serverside running on http://localhost:${PORT}`);
  console.log(`open http://localhost:${PORT} in your browser to try it`);
});

// graceful shutdown
process.on('SIGTERM', () => {
  for (const [slug, session] of sessions) teardown(slug, session);
  wss.close();
  server.close();
});
