// kick-chat.js — browser SDK for Kick.com live chat
//
// connects directly to Kick's Pusher WebSocket from the browser.
// resolves chatroom IDs by fetching from kick.com directly.
//
// usage:
//   <script src="kick-chat.js"></script>
//   <script>
//     const chat = new KickChat('xqc')
//     chat.on('message', ({ author, text, color }) => { ... })
//     chat.on('connected', ({ chatroomId }) => { ... })
//     chat.on('error', ({ message }) => { ... })
//     chat.connect()
//     chat.disconnect()
//   </script>
//
const PUSHER_KEY = "32cbd69e4b950bf97679";
const PUSHER_URL = `wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
const PING_INTERVAL = 30_000;
const RECONNECT_DELAY = 3_000;
const CHANNEL_DATA_URLS = [
  "https://kick.com/api/v1/channels/{slug}",
  "https://kick.com/api/v2/channels/{slug}",
];

class KickChat {
  // Store connection state for one Kick channel.
  constructor(channel) {
    if (typeof channel !== "string") {
      throw new TypeError("Channel must be a string.");
    }

    const normalizedChannel = channel.trim().toLowerCase();
    if (!normalizedChannel) {
      throw new Error("Channel is required.");
    }

    this._channel = normalizedChannel;
    this._ws = null;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._listeners = {};
    this._chatroomId = null;
    this._destroyed = false;
  }

  // Register an event listener.
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return this;
  }

  // Remove one listener or all listeners for an event.
  off(event, fn) {
    const list = this._listeners[event];
    if (!list) return this;
    this._listeners[event] = fn ? list.filter((f) => f !== fn) : [];
    return this;
  }

  // Notify listeners about connection, message, and error events.
  _emit(event, data) {
    const list = this._listeners[event];
    if (list) list.forEach((fn) => fn(data));
  }

  // Resolve the channel chatroom ID, then open the Pusher connection.
  async connect() {
    this._destroyed = false;
    this._clearReconnectTimer();
    this._closeSocket();
    this._emit("status", { state: "resolving" });

    try {
      this._chatroomId = await this._resolveChatroomId();
    } catch (err) {
      this._emit("error", {
        message: `Failed to resolve chatroom ID: ${err.message}`,
      });
      return;
    }

    this._connectPusher();
  }

  // Stop reconnect attempts and close the active socket.
  disconnect() {
    this._destroyed = true;
    this._clearReconnectTimer();
    this._closeSocket();
    this._emit("disconnected", {});
  }

  // Fetch the Kick channel payload until we get a usable chatroom ID.
  async _resolveChatroomId() {
    const slug = encodeURIComponent(this._channel);

    for (const template of CHANNEL_DATA_URLS) {
      const url = template.replace("{slug}", slug);
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const id = data.chatroom?.id;
          if (id) return id;
        }
      } catch {
        // CORS or network error — try next
      }
    }

    throw new Error("Could not resolve chatroom ID.");
  }

  // Connect to Kick's Pusher websocket and subscribe to the chatroom channel.
  _connectPusher() {
    if (this._destroyed || !this._chatroomId) return;

    this._clearReconnectTimer();
    this._closeSocket();

    const ws = new WebSocket(PUSHER_URL);
    this._ws = ws;

    ws.onopen = () => {
      this._clearPingTimer();
      this._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "pusher:ping", data: {} }));
        }
      }, PING_INTERVAL);
    };

    ws.onmessage = (e) => this._handlePusherMessage(ws, e.data);

    ws.onclose = () => {
      if (this._ws !== ws) return;

      this._clearPingTimer();
      this._ws = null;
      if (!this._destroyed) {
        this._emit("status", { state: "reconnecting" });
        if (!this._reconnectTimer) {
          this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connectPusher();
          }, RECONNECT_DELAY);
        }
      }
    };

    ws.onerror = () => {
      if (this._ws === ws) ws.close();
    };
  }

  // Handle Pusher protocol events and Kick chat message events.
  _handlePusherMessage(ws, rawMessage) {
    try {
      const msg = JSON.parse(rawMessage);

      if (msg.event === "pusher:connection_established") {
        ws.send(
          JSON.stringify({
            event: "pusher:subscribe",
            data: { auth: "", channel: `chatrooms.${this._chatroomId}.v2` },
          }),
        );
        return;
      }

      if (msg.event === "pusher_internal:subscription_succeeded") {
        this._emit("connected", { chatroomId: this._chatroomId });
        return;
      }

      if (msg.event === "pusher:ping") {
        ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        return;
      }

      if (msg.event === "pusher:pong") return;

      if (
        msg.event === "App\\Events\\ChatMessageEvent" ||
        msg.event === "App\\Events\\ChatMessageSentEvent"
      ) {
        const chatData = JSON.parse(msg.data);
        this._emit("message", {
          author:
            chatData.sender?.username || chatData.sender?.slug || "Anonymous",
          text: chatData.content || "",
          color: chatData.sender?.identity?.color || null,
          raw: chatData,
        });
      }
    } catch {
      // malformed pusher message
    }
  }

  // Stop the keepalive ping loop for the active websocket.
  _clearPingTimer() {
    if (!this._pingTimer) return;
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  // Cancel any queued reconnect so we never stack retries.
  _clearReconnectTimer() {
    if (!this._reconnectTimer) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  // Close the current socket and detach handlers from the old connection.
  _closeSocket() {
    this._clearPingTimer();
    if (!this._ws) return;

    const ws = this._ws;
    this._ws = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // ignore close errors
    }
  }
}

window.KickChat = KickChat;
