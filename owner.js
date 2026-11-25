module.exports.commands = [
  { name: "broadcast", aliases: ["bc"], ownerOnly: true, run: async c => {
    if (!c.text) return c.reply("『⚠️』 Usage: .broadcast your message");
    const chats = await c.sock.groupFetchAllParticipating();
    let sent = 0;
    for (const id of Object.keys(chats)) {
      try { await c.sock.sendMessage(id, { text: `𓆩 GHOST-MD BROADCAST 𓆪\n\n${c.text}` }); sent++; }
      catch (e) { console.error("Broadcast failed for", id, e.message); }
    }
    await c.reply(`『👑』 Broadcast sent to ${sent} groups.`);
  }},
  { name: "restart", aliases: [], ownerOnly: true, run: async c => {
    await c.reply("『⚙️』 Restart requested. The hosting platform should restart the process.");
    process.exit(0);
  }}
];
