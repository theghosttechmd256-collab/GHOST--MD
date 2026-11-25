async function groupAdminContext(c) {
  if (!c.chat.endsWith("@g.us")) { await c.reply("『⚠️』 This command only works in groups."); return null; }
  const meta = await c.sock.groupMetadata(c.chat);
  const member = meta.participants.find(p => p.id === c.sender);
  const botJid = c.sock.user?.id;
  const bot = meta.participants.find(p => p.id === botJid || p.id?.startsWith(botJid?.split(":")[0] || "___"));
  const isAdmin = member?.admin === "admin" || member?.admin === "superadmin";
  const botAdmin = bot?.admin === "admin" || bot?.admin === "superadmin";
  if (!isAdmin && !c.isOwner) { await c.reply("『⛔』 Group admins only."); return null; }
  if (!botAdmin) { await c.reply("『⚠️』 Make GHOST-MD a group admin first."); return null; }
  return meta;
}
module.exports.commands = [
  { name: "groupinfo", aliases: ["ginfo"], run: async c => {
    if (!c.chat.endsWith("@g.us")) return c.reply("『⚠️』 Use this in a group.");
    const m = await c.sock.groupMetadata(c.chat);
    await c.reply(`〕━━╮\n┃ 👥 GROUP INFO\n┃ NAME: ${m.subject}\n┃ MEMBERS: ${m.participants.length}\n╰━━━━━━━━━━━━━━━━╯`);
  }},
  { name: "tagall", aliases: ["everyone"], run: async c => {
    const m = await groupAdminContext(c); if (!m) return;
    const mentions = m.participants.map(p => p.id);
    await c.sock.sendMessage(c.chat, { text: `𓆩 GHOST-MD TAG ALL 𓆪\n${c.text || "Attention everyone"}\n` + mentions.map(j => `┃ @${j.split("@")[0]}`).join("\n"), mentions });
  }},
  { name: "close", aliases: ["lock"], run: async c => {
    if (!await groupAdminContext(c)) return;
    await c.sock.groupSettingUpdate(c.chat, "announcement");
    await c.reply("『🔒』 Group set to admins-only messaging.");
  }},
  { name: "open", aliases: ["unlock"], run: async c => {
    if (!await groupAdminContext(c)) return;
    await c.sock.groupSettingUpdate(c.chat, "not_announcement");
    await c.reply("『🔓』 Group messaging opened to participants.");
  }}
];
