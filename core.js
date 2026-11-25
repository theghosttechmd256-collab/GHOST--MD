const banner = (title, lines) =>
  `〕━━╮\n┃ 👻 GHOST-MD\n┃ ${title}\n${lines.map(x => `┃ ${x}`).join("\n")}\n╰━━━━━━━━━━━━━━━━╯`;

module.exports.commands = [
  { name: "menu", aliases: ["help", "commands"], run: async c => {
    const groups = ["menu, help, commands", "ping, alive, runtime", "owner, botinfo"];
    await c.reply(banner("⚡ COMMAND MENU", groups));
  }},
  { name: "ping", aliases: ["speed"], run: async c => c.reply(banner("🏓 PONG", ["STATUS: ONLINE", "VERSION: 2.5.0"])) },
  { name: "alive", aliases: ["online"], run: async c => c.reply(banner("📡 SYSTEM STATUS", ["STATUS: ACTIVE", "BOT: GHOST-MD", "VERSION: 2.5.0"])) },
  { name: "runtime", aliases: ["uptime"], run: async c => {
    const seconds = Math.floor(process.uptime());
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    await c.reply(banner("⏱️ RUNTIME", [`UPTIME: ${h}h ${m}m ${s}s`]));
  }},
  { name: "botinfo", aliases: ["info"], run: async c => c.reply(banner("🤖 BOT INFORMATION", ["NAME: GHOST-MD", "VERSION: 2.5.0", `PREFIX: ${c.prefix}`, "ENGINE: NODE.JS"])) },
  { name: "owner", aliases: ["creator"], run: async c => c.reply(banner("👑 OWNER", [`NUMBER: ${process.env.OWNER_NUMBER || "Not configured"}`])) }
];
