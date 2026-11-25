module.exports.commands = [
  { name: "jid", aliases: [], run: async c => c.reply(`『🆔』 CHAT JID\n${c.chat}`) },
  { name: "quote", aliases: ["echo"], run: async c => c.reply(c.text || "『⚠️』 Usage: .quote your text") },
  { name: "support", aliases: [], run: async c => c.reply("『👻』 GHOST-MD support: check the project README for setup and deployment help.") }
];
