"use strict";

require("dotenv").config();

const express = require("express");
const pino = require("pino");
const fs = require("node:fs");
const path = require("node:path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");

const { handleMessage, commandCount } = require("./handler");

const app = express();
const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR =
  process.env.AUTH_DIR || path.join(process.cwd(), "auth_info");

const state = {
  sock: null,
  connected: false,
  starting: false,
  pairing: false,
  qr: null,
  registered: false,
  connection: null,
  lastError: null,
  startPromise: null,
  reconnectTimer: null
};

const requestLimits = new Map();
const PAIR_COOLDOWN_MS = 15000;
const QR_READY_TIMEOUT_MS = 30000;

app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/assets", express.static(path.join(__dirname, "..", "assets")));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});

function getClientIP(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isPairRateLimited(ip) {
  const now = Date.now();
  const previous = requestLimits.get(ip) || 0;

  if (now - previous < PAIR_COOLDOWN_MS) return true;

  requestLimits.set(ip, now);

  if (requestLimits.size > 5000) {
    for (const [key, timestamp] of requestLimits) {
      if (now - timestamp > 60000) {
        requestLimits.delete(key);
      }
    }
  }

  return false;
}

function waitForQR(sock, timeoutMs = QR_READY_TIMEOUT_MS) {
  if (state.sock !== sock) {
    return Promise.reject(
      new Error("WhatsApp socket was replaced.")
    );
  }

  if (state.qr) return Promise.resolve(state.qr);

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      sock.ev.off("connection.update", onUpdate);
    };

    const finish = (error, qr) => {
      if (settled) return;

      settled = true;
      cleanup();

      if (error) reject(error);
      else resolve(qr);
    };

    const onUpdate = ({ connection, qr }) => {
      if (qr) {
        finish(null, qr);
      } else if (connection === "close") {
        finish(
          new Error(
            "WhatsApp closed the connection before it was ready."
          )
        );
      }
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          "Timed out waiting for WhatsApp. Check Render logs."
        )
      );
    }, timeoutMs);

    sock.ev.on("connection.update", onUpdate);

    if (state.qr) finish(null, state.qr);
  });
}

async function start() {
  if (state.sock) return state.sock;
  if (state.startPromise) return state.startPromise;

  state.starting = true;
  state.lastError = null;
  state.connection = null;

  state.startPromise = (async () => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state: auth, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    state.registered = Boolean(auth.creds.registered);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth,
      logger,
      browser: Browsers.windows("Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: undefined
    });

    state.sock = sock;
    state.qr = null;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on(
      "connection.update",
      ({ connection, lastDisconnect, qr }) => {
        if (connection) {
          state.connection = connection;
        }

        if (qr) {
          state.qr = qr;
          logger.info("WhatsApp QR is ready");
        }

        if (connection === "open") {
          state.connected = true;
          state.starting = false;
          state.qr = null;
          state.lastError = null;
          state.registered = true;

          if (state.reconnectTimer) {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
          }

          logger.info("WhatsApp connected successfully");
        }

        if (connection === "close") {
          state.connected = false;
          state.starting = false;
          state.sock = null;
          state.qr = null;

          const code =
            lastDisconnect?.error?.output?.statusCode;

          logger.warn(
            { code, lastDisconnect },
            "WhatsApp connection closed"
          );

          if (code === DisconnectReason.loggedOut) {
            state.lastError =
              "Logged out. Pair WhatsApp again if necessary.";

            state.registered = false;
          } else {
            state.lastError = "Connection closed. Reconnecting...";

            if (!state.reconnectTimer) {
              state.reconnectTimer = setTimeout(() => {
                state.reconnectTimer = null;

                start().catch(error => {
                  logger.error(
                    error,
                    "WhatsApp reconnection failed"
                  );
                });
              }, 5000);
            }
          }
        }
      }
    );

    sock.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
          try {
            await handleMessage(sock, msg);
          } catch (error) {
            logger.error(error, "Message handler error");
          }
        }
      }
    );

    state.starting = false;

    logger.info(
      { version },
      "GHOST-MD WhatsApp socket initialized"
    );

    return sock;
  })();

  try {
    return await state.startPromise;
  } catch (error) {
    state.sock = null;
    state.starting = false;
    state.lastError =
      error.message || "WhatsApp startup failed.";

    logger.error(error, "WhatsApp startup error");

    throw error;
  } finally {
    state.startPromise = null;
  }
}

async function ensureSocket() {
  const sock = await start();

  if (!sock) {
    throw new Error("WhatsApp socket is unavailable.");
  }

  return sock;
}

// HOME PAGE
app.get("/", (_req, res) => {
  res.redirect("/index.html");
});

// HEALTH CHECK
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot: "GHOST-MD",
    version: "2.5.0",
    commands: commandCount
  });
});

// STATUS
app.get("/api/status", (_req, res) => {
  res.json({
    connected: state.connected,
    starting: state.starting,
    pairing: state.pairing,
    qrReady: Boolean(state.qr),
    registered: state.registered,
    connection: state.connection,
    lastError: state.lastError
  });
});

// START WHATSAPP
app.post("/api/start", async (_req, res) => {
  try {
    if (state.connected) {
      return res.json({
        ok: true,
        message: "WhatsApp is already connected."
      });
    }

    await ensureSocket();

    return res.json({
      ok: true,
      message: "WhatsApp is starting. Wait for QR."
    });
  } catch (error) {
    logger.error(error, "Start endpoint error");

    return res.status(503).json({
      error: "Could not start WhatsApp. Check Render logs."
    });
  }
});

// GET QR CODE
app.get("/api/qr", async (_req, res) => {
  if (state.connected) {
    return res.status(409).json({
      error: "WhatsApp is already connected."
    });
  }

  try {
    const sock = await ensureSocket();

    const qr = await waitForQR(
      sock,
      QR_READY_TIMEOUT_MS
    );

    return res.json({
      qr,
      message: "Scan from WhatsApp > Linked Devices."
    });
  } catch (error) {
    logger.warn(error, "QR request error");

    return res.status(503).json({
      error: error.message || "QR is not ready yet."
    });
  }
});

// PAIRING CODE
app.post("/api/pair", async (req, res) => {
  if (isPairRateLimited(getClientIP(req))) {
    return res.status(429).json({
      error: "Wait 15 seconds before trying again."
    });
  }

  const phone = String(req.body?.phone || "")
    .replace(/\D/g, "");

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      error: "Enter a valid phone number with country code."
    });
  }

  if (state.connected) {
    return res.status(409).json({
      error: "WhatsApp is already connected."
    });
  }

  if (state.pairing) {
    return res.status(429).json({
      error: "A pairing request is already running."
    });
  }

  state.pairing = true;

  try {
    const sock = await ensureSocket();

    if (
      state.registered ||
      sock.authState?.creds?.registered
    ) {
      return res.status(409).json({
        error: "This session already has WhatsApp credentials. Wait for reconnection or intentionally reset the session before pairing again."
      });
    }

    // Wait until Baileys is ready.
    await waitForQR(sock);

    await new Promise(resolve => setTimeout(resolve, 1500));

    if (
      state.sock !== sock ||
      state.connection === "close"
    ) {
      throw new Error(
        "WhatsApp disconnected before pairing."
      );
    }

    const code = await sock.requestPairingCode(phone);

    logger.info("Pairing code generated successfully");

    return res.json({
      code,
      message:
        "Open WhatsApp > Linked Devices > Link with phone number."
    });
  } catch (error) {
    logger.error(error, "Pairing code error");

    return res.status(503).json({
      error:
        error.message ||
        "Could not generate pairing code."
    });
  } finally {
    state.pairing = false;
  }
});

// START SERVER
app.listen(PORT, "0.0.0.0", () => {
  logger.info(
    {
      port: PORT,
      commands: commandCount
    },
    "GHOST-MD server ready"
  );
});
