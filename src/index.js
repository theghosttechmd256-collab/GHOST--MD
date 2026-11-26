
"use strict";

require("dotenv").config();

const express = require("express");
const pino = require("pino");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { handleMessage, commandCount } = require("./handler");

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), "auth_info");

// Set these in Render Environment Variables.
const OWNER_NUMBER = String(process.env.PAIR_ALLOWED_NUMBER || "")
  .replace(/\D/g, "");

const PAIR_PAGE_TOKEN = String(process.env.PAIR_PAGE_TOKEN || "");

const state = {
  sock: null,
  connected: false,
  starting: false,
  pairing: false,
  qr: null,
  lastError: null,
  startPromise: null
};

// Basic per-IP cooldown.
const requestLimits = new Map();
const COOLDOWN_MS = 15000;

app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/assets", express.static(path.join(__dirname, "..", "assets")));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});

function clientIP(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function limited(ip) {
  const now = Date.now();
  const last = requestLimits.get(ip) || 0;

  if (now - last < COOLDOWN_MS) {
    return true;
  }

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

// Protect connection-start and QR endpoints with a secret.
function requirePairToken(req, res, next) {
  if (!PAIR_PAGE_TOKEN) {
    return res.status(503).json({
      error: "PAIR_PAGE_TOKEN is not configured on the server."
    });
  }

  const supplied = String(req.get("x-pair-token") || "");

  const a = Buffer.from(supplied);
  const b = Buffer.from(PAIR_PAGE_TOKEN);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      error: "Pair-page access denied. Enter the correct access key."
    });
  }

  next();
}

async function start() {
  if (state.sock) {
    return state.sock;
  }

  if (state.startPromise) {
    return state.startPromise;
  }

  state.starting = true;
  state.lastError = null;

  state.startPromise = (async () => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state: auth, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth,
      logger,
      printQRInTerminal: false,
      browser: ["GHOST-MD", "Chrome", "2.5.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    state.sock = sock;
    state.qr = null;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        state.qr = qr;
        logger.info("QR code received");
      }

      if (connection === "open") {
        state.connected = true;
        state.starting = false;
        state.qr = null;
        state.lastError = null;

        logger.info("WhatsApp connected");
      }

      if (connection === "close") {
        state.connected = false;
        state.starting = false;
        state.sock = null;
        state.qr = null;

        const code = lastDisconnect?.error?.output?.statusCode;

        logger.warn({ code }, "WhatsApp connection closed");

        if (code === DisconnectReason.loggedOut) {
          state.lastError = "Logged out. Pair your account again.";
          logger.warn("WhatsApp logged out");
        } else {
          state.lastError = "Connection closed. Reconnecting...";
          setTimeout(() => {
            start().catch(err => logger.error(err));
          }, 5000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          await handleMessage(sock, msg);
        } catch (error) {
          logger.error(error, "Handler error");
        }
      }
    });

    state.starting = false;
    logger.info("WhatsApp socket started");

    return sock;
  })();

  try {
    return await state.startPromise;
  } catch (error) {
    state.sock = null;
    state.starting = false;
    state.lastError = "WhatsApp startup failed.";

    logger.error(error, "Startup error");
    throw error;
  } finally {
    state.startPromise = null;
  }
}

// Wait until the socket has been initialized.
async function ensureSocket() {
  const sock = await start();

  if (!sock) {
    throw new Error("WhatsApp socket is unavailable.");
  }

  return sock;
}

// HOME
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

// BOT STATUS
app.get("/api/status", (_req, res) => {
  res.json({
    connected: state.connected,
    starting: state.starting,
    pairing: state.pairing,
    qrReady: Boolean(state.qr),
    lastError: state.lastError
  });
});

// START CONNECTION (QR page)
app.post("/api/start", requirePairToken, async (req, res) => {
  if (limited(clientIP(req))) {
    return res.status(429).json({
      error: "Please wait before trying again."
    });
  }

  try {
    await ensureSocket();

    return res.json({
      ok: true,
      message: "WhatsApp connection started. Wait for the QR."
    });
  } catch (error) {
    logger.error(error);

    return res.status(503).json({
      error: "Could not start WhatsApp connection."
    });
  }
});

// GET QR (QR page)
app.get("/api/qr", requirePairToken, (_req, res) => {
  if (state.connected) {
    return res.status(409).json({
      error: "WhatsApp is already connected."
    });
  }

  if (!state.qr) {
    return res.status(404).json({
      error: "QR not ready. Start the connection and wait a few seconds."
    });
  }

  return res.json({
    qr: state.qr,
    message: "QR ready. Scan using WhatsApp Linked Devices."
  });
});

// PAIR CODE (pair.html)
app.post("/api/pair", async (req, res) => {
  if (limited(clientIP(req))) {
    return res.status(429).json({
      error: "Wait 15 seconds before requesting another code."
    });
  }

  const phone = String(req.body?.phone || "").replace(/\D/g, "");

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      error: "Enter a valid international phone number."
    });
  }

  // The page accepts international numbers, but only the
  // configured owner number is permitted to link this bot.
  if (!OWNER_NUMBER) {
    return res.status(503).json({
      error: "PAIR_ALLOWED_NUMBER is missing from Render environment."
    });
  }

  if (phone !== OWNER_NUMBER) {
    return res.status(403).json({
      error: "This number is not authorized to pair this bot."
    });
  }

  if (state.connected) {
    return res.status(409).json({
      error: "WhatsApp is already connected."
    });
  }

  if (state.pairing) {
    return res.status(429).json({
      error: "Pairing is already in progress."
    });
  }

  state.pairing = true;

  try {
    const sock = await ensureSocket();

    if (typeof sock.requestPairingCode !== "function") {
      throw new Error("Pairing code is unavailable.");
    }

    const code = await sock.requestPairingCode(phone);

    return res.json({
      code,
      message: "Open WhatsApp → Linked Devices → Link with phone number."
    });
  } catch (error) {
    logger.error(error, "Pair-code error");

    return res.status(503).json({
      error: error.message || "Could not generate pairing code."
    });
  } finally {
    state.pairing = false;
  }
});

// SERVER
app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      commands: commandCount
    },
    "GHOST-MD server ready"
  );
});
        
