
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
  lastError: null
};

// Basic protection against repeated public pairing requests.
const requestLimits = new Map();
const REQUEST_COOLDOWN_MS = 15000;

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

  if (now - previous < REQUEST_COOLDOWN_MS) {
    return true;
  }

  requestLimits.set(ip, now);

  // Clean old entries occasionally.
  if (requestLimits.size > 5000) {
    for (const [key, value] of requestLimits) {
      if (now - value > 60000) {
        requestLimits.delete(key);
      }
    }
  }

  return false;
}

async function start() {
  if (state.sock || state.starting) return;

  state.starting = true;
  state.lastError = null;

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  try {
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

        logger.info("WhatsApp connected successfully");
      }

      if (connection === "close") {
        state.connected = false;
        state.starting = false;
        state.sock = null;

        const code = lastDisconnect?.error?.output?.statusCode;

        logger.warn({ code }, "WhatsApp connection closed");

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            start().catch(error => logger.error(error));
          }, 5000);
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
    logger.info("WhatsApp socket initialized");

  } catch (error) {
    state.starting = false;
    state.sock = null;
    state.lastError = "WhatsApp startup failed.";

    logger.error(error, "WhatsApp startup error");
    throw error;
  }
}

// Wait for the socket to become available after starting.
async function ensureSocket() {
  if (!state.sock && !state.starting) {
    await start();
  }

  const timeout = Date.now() + 20000;

  while (!state.sock && Date.now() < timeout) {
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  if (!state.sock) {
    throw new Error("WhatsApp is still starting. Try again shortly.");
  }

  return state.sock;
}

app.get("/", (_req, res) => {
  res.redirect("/index.html");
});

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
    pairing: state.pairing,
    lastError: state.lastError
  });
});

// International pairing endpoint.
app.post("/api/pair", async (req, res) => {
  const ip = getClientIP(req);

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: "Please wait 15 seconds before requesting another code."
    });
  }

  // Accept phone numbers from all countries.
  const phone = String(req.body?.phone || "").replace(/\D/g, "");

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      error: "Enter a valid international number with country code."
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

    if (!sock.requestPairingCode) {
      throw new Error("Pairing is unavailable. Check Baileys installation.");
    }

    const code = await sock.requestPairingCode(phone);

    logger.info("Pairing code requested");

    return res.json({
      code,
      message: "Open WhatsApp > Linked Devices > Link with phone number."
    });

  } catch (error) {
    logger.error(error, "Pairing code generation failed");

    return res.status(503).json({
      error: error.message || "Could not generate pairing code. Check server logs."
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
                                          
