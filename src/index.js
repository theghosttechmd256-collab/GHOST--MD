
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
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { handleMessage, commandCount } = require("./handler");

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), "auth_info");

const state = {
  sock: null,
  connected: false,
  starting: false,
  pairing: false,
  qr: null,
  lastError: null,
  startPromise: null
};

// Basic request cooldown per IP.
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

function getClientIP(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const previous = requestLimits.get(ip) || 0;

  if (now - previous < COOLDOWN_MS) {
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

async function start() {
  if (state.sock) return state.sock;
  if (state.startPromise) return state.startPromise;

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
        logger.info("WhatsApp QR received");
      }

      if (connection === "open") {
        state.connected = true;
        state.starting = false;
        state.qr = null;
        state.lastError = null;

        logger.info("WhatsApp connected successfully");
      }

      if (connection === "close") {
        state.connected = false;
        state.starting = false;
        state.sock = null;
        state.qr = null;

        const code = lastDisconnect?.error?.output?.statusCode;

        logger.warn({ code }, "WhatsApp connection closed");

        if (code === DisconnectReason.loggedOut) {
          state.lastError = "Logged out. Pair your WhatsApp again.";
        } else {
          state.lastError = "Connection closed. Reconnecting...";

          setTimeout(() => {
            start().catch(error => logger.error(error));
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
          logger.error(error, "Message handler error");
        }
      }
    });

    state.starting = false;

    logger.info("WhatsApp socket initialized");

    return sock;
  })();

  try {
    return await state.startPromise;
  } catch (error) {
    state.sock = null;
    state.starting = false;
    state.lastError = "WhatsApp startup failed.";

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
    lastError: state.lastError
  });
});

// START WHATSAPP (QR PAGE)
app.post("/api/start", async (req, res) => {
  if (isRateLimited(getClientIP(req))) {
    return res.status(429).json({
      error: "Please wait 15 seconds before trying again."
    });
  }

  try {
    await ensureSocket();

    return res.json({
      ok: true,
      message: "WhatsApp started. Wait for the QR code to become ready."
    });
  } catch (error) {
    logger.error(error, "Start endpoint error");

    return res.status(503).json({
      error: "Could not start WhatsApp connection."
    });
  }
});

// GET WHATSAPP QR
app.get("/api/qr", (req, res) => {
  if (isRateLimited(getClientIP(req))) {
    return res.status(429).json({
      error: "Please wait before refreshing the QR code."
    });
  }

  if (state.connected) {
    return res.status(409).json({
      error: "WhatsApp is already connected."
    });
  }

  if (!state.qr) {
    return res.status(404).json({
      error: "QR is not ready yet. Start WhatsApp and wait a few seconds."
    });
  }

  return res.json({
    qr: state.qr,
    message: "QR code ready. Scan it from WhatsApp Linked Devices."
  });
});

// PAIRING CODE — ALL INTERNATIONAL NUMBERS
app.post("/api/pair", async (req, res) => {
  if (isRateLimited(getClientIP(req))) {
    return res.status(429).json({
      error: "Please wait 15 seconds before requesting another code."
    });
  }

  const phone = String(req.body?.phone || "").replace(/\D/g, "");

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
      error: "A pairing request is already in progress. Wait."
    });
  }

  state.pairing = true;

  try {
    const sock = await ensureSocket();

    if (typeof sock.requestPairingCode !== "function") {
      throw new Error("Pairing code function is unavailable.");
    }

    const code = await sock.requestPairingCode(phone);

    logger.info("Pairing code request completed");

    return res.json({
      code,
      message: "Code generated. Open WhatsApp > Linked Devices > Link with phone number."
    });
  } catch (error) {
    logger.error(error, "Pairing code generation error");

    return res.status(503).json({
      error: error.message || "Could not generate pairing code. Please try again."
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
      
