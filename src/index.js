
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
const OWNER_NUMBER = String(process.env.PAIR_ALLOWED_NUMBER || "").replace(/\D/g, "");
const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), "auth_info");

const state = {
  sock: null,
  connected: false,
  starting: false,
  pairing: false,
  lastError: null
};

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
  if (state.starting || state.connected) return;

  state.starting = true;
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
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

        const code = lastDisconnect?.error?.output?.statusCode;

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => start().catch(logger.error), 5000);
        } else {
          state.lastError = "Logged out. Pair your account again.";
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
  } catch (error) {
    state.starting = false;
    state.lastError = "WhatsApp startup failed.";
    logger.error(error);
    throw error;
  }
}

app.get("/", (_req, res) => res.redirect("/index.html"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, bot: "SITANI TECH MD", commands: commandCount });
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

  if (!OWNER_NUMBER) {
    return res.status(503).json({
      error: "Set PAIR_ALLOWED_NUMBER in your hosting environment."
    });
  }

  if (phone !== OWNER_NUMBER) {
    return res.status(403).json({
      error: "This pairing page is restricted to its authorized owner."
    });
  }

  if (state.connected) {
    return res.status(409).json({ error: "Already connected." });
  }

  if (state.pairing) {
    return res.status(429).json({
      error: "Pairing is in progress. Wait and retry."
    });
  }

  state.pairing = true;

  try {
    if (!state.sock) await start();

    if (!state.sock?.requestPairingCode) {
      return res.status(503).json({
        error: "WhatsApp is starting. Wait a few seconds and retry."
      });
    }

    const code = await state.sock.requestPairingCode(phone);

    return res.json({
      code,
      message: "WhatsApp → Linked Devices → Link with phone number."
    });
  } catch (error) {
    logger.error(error);
    return res.status(503).json({
      error: "Could not generate pairing code. Check the server logs."
    });
  } finally {
    state.pairing = false;
  }
});

// QR endpoint intentionally not exposed without additional authentication.

app.listen(PORT, () => {
  logger.info({ port: PORT, commands: commandCount }, "SITANI TECH MD ready");
});
          
