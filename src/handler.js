const fs = require("node:fs");
const path = require("node:path");

const commandMap = new Map();
const commandDir = path.join(__dirname, "..", "commands");

for (const file of fs.readdirSync(commandDir).filter(f => f.endsWith(".js"))) {
  const mod = require(path.join(commandDir, file));
  for (const command of mod.commands || []) {
    commandMap.set(command.name.toLowerCase(), command);
    for (const alias of command.aliases || []) commandMap.set(alias.toLowerCase(), command);
  }
}

function getText(message) {
  const m = message.message || {};
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption || "";
}

async function handleMessage(sock, message) {
  const chat = message.key.remoteJid;
  if (!chat || !message.message || message.key.fromMe) return;
  const text = getText(message).trim();
  const prefix = process.env.PREFIX || ".";
  if (!text.startsWith(prefix)) return;

  const [rawName, ...args] = text.slice(prefix.length).trim().split(/\s+/);
  if (!rawName) return;
  const command = commandMap.get(rawName.toLowerCase());
  if (!command) return;

  const sender = message.key.participant || message.key.remoteJid;
  const owner = (process.env.OWNER_NUMBER || "").replace(/\D/g, "");
  const senderNumber = sender.split("@")[0].replace(/\D/g, "");
  const isOwner = Boolean(owner && senderNumber.endsWith(owner));

  const context = {
    sock, message, chat, sender, senderNumber, isOwner, args,
    text: args.join(" "), prefix, commandName: rawName,
    reply: (body) => sock.sendMessage(chat, { text: body }, { quoted: message })
  };

  try {
    if (command.ownerOnly && !isOwner) return context.reply("『⛔』 This command is for the bot owner only.");
    await command.run(context);
  } catch (error) {
    console.error("Command error:", command.name, error);
    await context.reply("『⚠️』 Command failed safely. Please try again later.");
  }
}

module.exports = { handleMessage, commandCount: new Set([...commandMap.values()]).size };
