'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, 'session');

const logger = pino({
  level: 'silent'
});

// Ask for a phone number if it is not provided in environment variables.
function askPhoneNumber() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Enter WhatsApp number with country code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Normalize international phone numbers to digits only.
function normalizeNumber(number) {
  return number.replace(/\D/g, '');
}

async function startBot() {
  console.log('Starting Ghost MD...');

  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const { state, saveCreds } =
    await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: ['Ghost MD', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  // Save session credentials whenever they change.
  sock.ev.on('creds.update', saveCreds);

  // Pairing code for accounts that aren't registered yet.
  if (!state.creds.registered) {
    let number = process.env.PAIRING_NUMBER;

    if (!number) {
      number = await askPhoneNumber();
    }

    number = normalizeNumber(number);

    if (!/^\d{7,15}$/.test(number)) {
      console.error('Invalid number. Include your country code.');
      process.exit(1);
    }

    try {
      const code = await sock.requestPairingCode(number);
      console.log('\n================================');
      console.log(' YOUR WHATSAPP PAIRING CODE');
      console.log('================================');
      console.log(`        ${code}`);
      console.log('================================');
      console.log('Open WhatsApp > Linked devices');
      console.log('Choose Link with phone number');
      console.log('Enter the code above.\n');
    } catch (error) {
      console.error('Pairing code error:', error.message);
    }
  }

  // Handle connection changes.
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting') {
      console.log('Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      console.log('Ghost MD connected successfully!');
      console.log('Bot is online.');
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const loggedOut =
        statusCode === DisconnectReason.loggedOut;

      console.log('Connection closed.');

      if (loggedOut) {
        console.log('Session logged out. Pair again.');
        return;
      }

      console.log('Reconnecting in 5 seconds...');

      setTimeout(() => {
        startBot().catch(console.error);
      }, 5000);
    }
  });

  // Incoming messages.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      if (!message.message) continue;
      if (message.key.fromMe) continue;

      const sender = message.key.remoteJid;

      if (!sender) continue;

      console.log('New message from:', sender);
    }
  });

  return sock;
}

// Handle unexpected errors.
process.on('uncaughtException', (error) => {
  console.error('Unexpected error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

startBot().catch((error) => {
  console.error('Failed to start Ghost MD:', error);
});
