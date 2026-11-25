# 𓆩 GHOST-MD V2.5.0 𓆪

<p align="center"><img src="assets/ghost-md-poster.png" alt="GHOST-MD ghost artwork" width="100%"></p>

**〕━━╮**  
**┃ 👻 GHOST-MD — WHATSAPP BOT**  
**┃ ⚡ VERSION: 2.5.0**  
**╰━━━━━━━━━━━━━━━━╯**

## Pairing pages

After deployment, both pages use your deployed service URL:
- QR scan: `https://YOUR-SERVICE.onrender.com/qr.html`
- Pair code: `https://YOUR-SERVICE.onrender.com/pair.html`
- Home: `https://YOUR-SERVICE.onrender.com/index.html`

These are URL templates, not live links until you deploy.

## Setup and environment

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Set `PANEL_PASSWORD` to a long, random secret.
4. Set `OWNER_NUMBER` to your number in international format, digits only.
5. Install and run:

```bash
npm install
npm start
```

Never upload `.env` or `auth_info/` to GitHub. `.gitignore` excludes them. On a hosting platform, add the environment variables in its dashboard instead of uploading `.env`.

## Included commands

- Core: `.menu`, `.help`, `.ping`, `.alive`, `.runtime`, `.botinfo`, `.owner`
- Owner: `.broadcast`, `.restart`
- Group: `.groupinfo`, `.tagall`, `.close`, `.open`
- Utility: `.jid`, `.quote`, `.support`

The command loader reads JavaScript modules from `commands/`. This is a working starter command set, not 600 completed commands. AI, sticker generation, downloaders, anti-delete, status tools and welcome automation still need implementation and testing.

## Deployment

Use the included `render.yaml` as a starting point. Configure a persistent disk for `AUTH_DIR` so the WhatsApp login survives restarts. Review your host's current pricing and disk availability.

This project uses an unofficial WhatsApp Web library, is not affiliated with WhatsApp/Meta, and may carry account restriction risk. Pair only an account you own or are authorized to manage. Keep QR codes, pairing codes, passwords and session files private.

**〕━━╮**  
**┃ 𓆩 GHOST-MD 𓆪**  
**┃ BY THE GHOST**  
**╰━━━━━━━━━━━━━━━━╯**
