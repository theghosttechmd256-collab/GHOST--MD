
require("dotenv").config();

const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
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
  qr: null,
  connected: false,
  starting: false,
  pairing: false,
  lastError: null
};

// Render runs behind a proxy
app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));

app.use(express.static(path.join(__dirname, "..", "public")));

app.use(
  "/assets",
  express.static(path.join(__dirname, "..", "assets"), {
    maxAge: "7d"
  })
);

// Basic public request limit
const requests = new Map();

function publicLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const limit = requests.get(ip);

  if (limit && now < limit.reset && limit.count >= 10) {
    return res.status(429).json({
      error: "Too many requests. Please wait and try again."
    });
  }

  if (!limit || now >= limit.reset) {
    requests.set(ip, {
      count: 1,
      reset: now + 10 * 60 * 1000
    });
  } else {
    limit.count++;
  }

  next();
}

// Security headers
app.use((_q, s, n) => {
  s.setHeader("X-Content-Type-Options", "nosniff");
  s.setHeader("Referrer-Policy", "no-referrer");
  s.setHeader("Cache-Control", "no-store");
  n();
});

async function start() {
  if (state.starting || state.connected) return;

  state.starting = true;
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
      browser: ["GHOST-MD", "Chrome", "2.5.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    state.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({
      connection,
      qr,
      lastDisconnect
    }) => {
      if (qr) {
        try {
          state.qr = await QRCode.toDataURL(qr);
        } catch (e) {
          logger.error(e);
        }
      }

      if (connection === "open") {
        state.connected = true;
        state.starting = false;
        state.qr = null;
        state.lastError = null;

        logger.info("GHOST-MD connected");
      }

      if (connection === "close") {
        state.connected = false;
        state.starting = false;
        state.qr = null;

        if (
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut
        ) {
          setTimeout(() => {
            start().catch(e => logger.error(e));
          }, 5000);
        } else {
          state.lastError =
            "Logged out. Clear the private auth folder on the host and pair again.";
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        await handleMessage(sock, msg);
      }
    });
  } catch (e) {
    state.starting = false;
    state.lastError =
      "WhatsApp startup failed. Check server logs.";

    logger.error(e);
    throw e;
  }
}

app.get("/", (_q, s) => s.redirect("/index.html"));

app.get("/health", (_q, s) =>
  s.json({
    ok: true,
    bot: "GHOST-MD",
    version: "2.5.0",
    commands: commandCount
  })
);

// Public status
app.get("/api/status", publicLimit, (_q, s) =>
  s.json({
    connected: state.connected,
    starting: state.starting,
    qrReady: !!state.qr,
    lastError: state.lastError
  })
);

// Start connection
app.post("/api/start", publicLimit, async (_q, s) => {
  try {
    await start();

    s.json({
      ok: true,
      message: "Connection starting. Try again shortly."
    });
  } catch (e) {
    s.status(503).json({
      error: state.lastError
    });
  }
});

// QR code
app.get("/api/qr", publicLimit, async (_q, s) => {
  if (state.connected) {
    return s.status(409).json({
      error: "Already connected."
    });
  }

  if (!state.sock) {
    try {
      await start();
    } catch (e) {
      return s.status(503).json({
        error: state.lastError
      });
    }
  }

  if (!state.qr) {
    return s.status(202).json({
      waiting: true,
      message: "QR not ready yet. Retry shortly."
    });
  }

  s.json({
    qr: state.qr
  });
});

// Pairing code
app.post("/api/pair", publicLimit, async (req, res) => {
  const phone = String(req.body?.phone || "")
    .replace(/\D/g, "");

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      error: "Enter international number with country code, digits only."
    });
  }

  if (state.connected) {
    return res.status(409).json({
      error: "Already connected."
    });
  }

  if (state.pairing) {
    return res.status(429).json({
      error: "Pairing request in progress. Wait and retry."
    });
  }

  try {
    if (!state.sock) await start();

    if (!state.sock?.requestPairingCode) {
      return res.status(503).json({
        error: "Connection not ready. Retry shortly."
      });
    }

    state.pairing = true;

    const code =
      await state.sock.requestPairingCode(phone);

    res.json({
      code,
      message:
        "WhatsApp → Linked devices → Link with phone number."
    });
  } catch (e) {
    logger.warn(e);

    res.status(503).json({
      error: "Could not generate code. Check number and retry."
    });
  } finally {
    state.pairing = false;
  }
});

app.listen(PORT, () =>
  logger.info(
    { port: PORT, commands: commandCount },
    "GHOST-MD server ready"
  )
);
    
