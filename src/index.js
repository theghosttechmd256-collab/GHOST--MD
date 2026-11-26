
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
const AUTH_DIR =
  process.env.AUTH_DIR || path.join(process.cwd(), "auth_info");

const state = {
  sock: null,
  connected: false,
  starting: false,
  pairing: false,
  qr: null,
  lastError: null,
  startPromise: null
};

const requestLimits = new Map();
const COOLDOWN_MS = 15000;

app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/assets", express.static(path.join(__dirname, "..", "assets")));

function isRateLimited(ip) {
  const now = Date.now();
  const previous = requestLimits.get(ip) || 0;

  if (now - previous < COOLDOWN_MS) return true;

  requestLimits.set(ip, now);

  if (requestLimits.size > 5000) {
    for (const [key, time] of requestLimits) {
      if (now - time > 60000) requestLimits.delete(key);
    }
  }

  return false;
}

function getClientIP(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// START WHATSAPP SOCKET
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
        logger.info("WhatsApp QR ready");
      }

      if (connection === "connecting") {
        state.starting = false;
        logger.info("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        state.connected = true;
        state.starting = false;
        state.qr = null;
        state.lastError = null;

        logger.info("GHOST-MD connected successfully");
      }

      if (connection === "close") {
        state.connected = false;
        state.starting = false;
        state.sock = null;
        state.qr = null;

        const code = lastDisconnect?.error?.output?.statusCode;

        logger.error({ code }, "WhatsApp connection closed");

        if (code === DisconnectReason.loggedOut) {
          state.lastError =
            "WhatsApp logged out. Clear the old session only if you intend to pair again.";
          logger.error(state.lastError);
          return;
        }

        state.lastError = "Connection closed. Reconnecting...";

        setTimeout(() => {
          start().catch(error => {
            logger.error(error, "Reconnect failed");
          });
        }, code === DisconnectReason.restartRequired ? 1000 : 5000);
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

    logger.info("GHOST-MD socket initialized");

    return sock;
  })();

  try {
    return await state.startPromise;
  } catch (error) {
    state.sock = null;
    state.starting = false;
    state.lastError = error.message;

    logger.error(error, "WhatsApp startup failed");
    throw error;
  } finally {
    state.startPromise = null;
  }
}

async function ensureSocket() {
  const sock = await start();

  if (!sock) {
    throw new Error("WhatsApp socket unavailable");
  }

  return sock;
}

// WAIT FOR QR EVENT BEFORE REQUESTING PAIRING CODE
function getPairingCode(sock, phone) {
  if (state.connected) {
    return Promise.reject(
      new Error("WhatsApp is already connected.")
    );
  }

  if (sock.authState?.creds?.registered) {
    return Promise.reject(
      new Error("This authentication session is already registered.")
    );
  }

  return new Promise((resolve, reject) => {
    let finished = false;

    const cleanup = () => {
      clearTimeout(timer);
      sock.ev.off("connection.update", onUpdate);
    };

    const fail = error => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new Error(
        "WhatsApp did not become ready. Please try again."
      ));
    }, 30000);

    const onUpdate = async ({ qr, connection }) => {
      if (finished) return;

      if (connection === "close") {
        fail(new Error("WhatsApp closed before pairing code generation."));
        return;
      }

      if (!qr) return;

      finished = true;
      cleanup();

      try {
        const code = await sock.requestPairingCode(phone);

        state.qr = null;

        logger.info("Pairing code generated successfully");

        resolve(code);
      } catch (error) {
        state.lastError = error.message;
        logger.error(error, "Pairing code request failed");
        reject(error);
      }
    };

    sock.ev.on("connection.update", onUpdate);

    // Handle QR that arrived before this listener was attached.
    if (state.qr) {
      onUpdate({ qr: state.qr });
    }
  });
}

// HOME
app.get("/", (_req, res) => {
  res.redirect("/index.html");
});

// HEALTH
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

// START QR CONNECTION
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
      message: "WhatsApp started. Wait for QR code."
    });
  } catch (error) {
    logger.error(error, "Start endpoint error");

    return res.status(503).json({
      error: "Could not start WhatsApp."
    });
  }
});

// GET QR
app.get("/api/qr", (_req, res) => {
  if (state.connected) {
    return res.status(409).json({
      error: "WhatsApp is already connected."
    });
  }

  if (!state.qr) {
    return res.status(404).json({
      error: "QR not ready. Start WhatsApp and wait."
    });
  }

  return res.json({
    qr: state.qr,
    message: "Scan using WhatsApp Linked Devices."
  });
});

// PAIRING CODE
app.post("/api/pair", async (req, res) => {
  const ip = getClientIP(req);

  if (isRateLimited(ip)) {
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

    const code = await getPairingCode(sock, phone);

    return res.json({
      ok: true,
      code,
      message:
        "Open WhatsApp > Linked Devices > Link with phone number."
    });

  } catch (error) {
    logger.error(error, "Pairing endpoint error");

    return res.status(503).json({
      error: error.message || "Pairing failed. Try again."
    });

  } finally {
    state.pairing = false;
  }
});

// SERVER
app.listen(PORT, "0.0.0.0", () => {
  logger.info(
    {
      port: PORT,
      commands: commandCount
    },
    "GHOST-MD server ready"
  );
});
        
