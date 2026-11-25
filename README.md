# GHOST-MD

A Node.js WhatsApp automation starter with a Cypher-inspired command experience.

## Included in this starter
- WhatsApp QR pairing using Baileys
- Express health endpoint for Render
- `.menu`, `.ping`, `.alive`, `.owner`, `.groupinfo`
- Optional direct-message auto-reply (off by default)
- Environment-based configuration
- Basic error handling and reconnect logic

## Important
This project uses an unofficial WhatsApp Web integration. It is not affiliated with or endorsed by WhatsApp/Meta. Unofficial automation may violate WhatsApp terms and can result in account restrictions. Test with a secondary number and obtain consent before automating group conversations. Do not use this bot for spam, harassment, message flooding, or crash payloads.

Anti-delete/message retention is intentionally not enabled by default. Add it only with clear participant notice and consent, and follow applicable privacy laws. Downloader, status-saving, AI, sticker conversion, and full group moderation are follow-up modules; they are not falsely advertised as implemented in this starter.

## Local setup
1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `OWNER_NUMBER`.
4. Run `npm start`.
5. Scan the QR from WhatsApp > Linked devices.

Keep `auth_info/` private. Never commit it or share your QR/session files.

## Render deployment
1. Push this repository to GitHub.
2. Create a Render Web Service from the repository.
3. Keep the persistent disk mounted at `/opt/render/project/src/auth_info`.
4. Add environment variables from `.env.example` in Render.
5. Deploy and inspect logs for the QR code. Pair using a secondary WhatsApp number.

A Render instance with persistent storage may require a paid plan. Without persistent storage, the WhatsApp session may be lost on redeploy/restart.

## Roadmap
- Phase 2: AI chat integration and sticker conversion
- Phase 3: Welcome messages and admin-checked group moderation
- Phase 4: consent-based message audit tools and safe status utilities
- Phase 5: supported downloader integrations and automated tests
