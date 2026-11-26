
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
  lastError: null,
  startPromise: null
};

// Simple in-memory request limiter.
// Limits repeated pairing requests from the same IP.
const requestCounts = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS = 5;

function allowRequest(ip) {
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now - entry.start > WINDOW_MS) {
    requestCounts.set(ip, { start: now, count: 1 });
    return true;
  }

  if (entry.count >= MAX_REQUESTS) return false;

  entry.count++;
  return true;
}

app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/assets", express.static(path.join(__dirname, "..", "assets")));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});

async function start() {
  if (state.connected && state.sock) return state.sock;
  if (state.startPromise) return state.startPromise;

  state.starting = true;

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
      browser: ["SITANI TECH MD", "Chrome", "2.5.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    state.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        state.connected = true;
        state.starting = false;
        state.lastError = null;
        logger.info("WhatsApp connected");
      }

      if (connection === "close") {
        state.connected = false;
        state.starting = false;
        state.sock = null;
        state.startPromise = null;

        const code = lastDisconnect?.error?.output?.statusCode;

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => start().catch(err => logger.error(err)), 5000);
        } else {
          state.lastError = "Logged out. Pair again.";
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
    return sock;
  })();

  try {
    return await state.startPromise;
  } catch (error) {
    state.starting = false;
    state.startPromise = null;
    state.lastError = "WhatsApp startup failed.";
    logger.error(error);
    throw error;
  }
}

app.get("/", (_req, res) => res.redirect("/index.html"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot: "SITANI TECH MD",
    commands: commandCount
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    connected: state.connected,
    starting: state.starting,
    lastError: state.lastError
  });
});

app.post("/api/pair", async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      error: "Enter an international number with country code, digits only."
    });
  }

  if (!allowRequest(ip)) {
    return res.status(429).json({
      error: "Too many pairing requests. Try again later."
    });
  }

  if (state.connected) {
    return res.status(409).json({
      error: "WhatsApp is already connected."
    });
  }

  if (state.pairing) {
    return res.status(429).json({
      error: "A pairing request is already running. Wait and retry."
    });
  }

  state.pairing = true;

  try {
    const sock = await start();

    // Give the WhatsApp socket a short moment to initialize.
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (!sock || typeof sock.requestPairingCode !== "function") {
      return res.status(503).json({
        error: "WhatsApp is still starting. Retry shortly."
      });
    }

    const code = await sock.requestPairingCode(phone);

    return res.json({
      code,
      message:
        "On WhatsApp, open Linked Devices and select Link with phone number."
    });
  } catch (error) {
    logger.error(error, "Pairing code generation failed");
    return res.status(503).json({
      error: "Pairing failed. Check server logs and try again."
    });
  } finally {
    state.pairing = false;
  }
});

app.listen(PORT, () => {
  logger.info(
    { port: PORT, commands: commandCount },
    "SITANI TECH MD server ready"
  );
});
            
