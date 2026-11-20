**English** | [فارسی](./README.fa.md)

# Telegram Uploader Bot — Serverless File Store on Telegram

[![Live Docs](https://img.shields.io/badge/Docs-Live_Guide-2AABEE?style=flat-square&logo=telegram&logoColor=white)](https://azipa.github.io/projects/telegram-uploader-bot/)
![Telegram Serverless](https://img.shields.io/badge/Runtime-Telegram_Serverless-26A5E4?style=flat-square)
![@tgcloud/cli](https://img.shields.io/badge/@tgcloud%2Fcli-0.2.0-0969DA?style=flat-square)
![Node.js CI](https://img.shields.io/badge/Node.js_CI-24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen?style=flat-square)](./LICENSE)

A production **Telegram uploader bot** and **Telegram file store bot** built natively for **Telegram Serverless** (`@tgcloud/cli`) with a **built-in 21-table SQLite** database and **zero VPS** or external server hosting. Upload single files or media batches to **share files via deep links**, enforce **force-join channels**, and configure **content protection**, **auto-delete** timers, **one-time burn links**, and **auto-rotating links** with a bilingual English/Persian UI and automated **GitHub Actions deploy**.

> [!NOTE]
> - **Backend-only bot:** Runs natively on Telegram Serverless with no Mini App or external web server; media stays on Telegram servers (`file_id` + optional private Storage Channel mirror).
> - **Prefer Cloudflare Workers + D1?** Check out the sister edition: [AZiPA/telegram-uploader-bot-cloudflare](https://github.com/AZiPA/telegram-uploader-bot-cloudflare) ([Live Docs](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/)).

## Quick Start — Deploy in 2 Minutes (GitHub Actions)

1. **Enable Serverless in `@BotFather`:** Create or select your bot, turn **Serverless ON**, and copy your **CLI Access Token** (`app<id>:<secret>` from `Serverless → CLI Access → Access token` — NOT the regular HTTP Bot API token).
2. **Fork the repository:** Click **Fork** on [`AZiPA/telegram-uploader-bot`](https://github.com/AZiPA/telegram-uploader-bot) to create your own copy.
3. **Add Repository Secrets:** Go to **Settings → Secrets and variables → Actions** and add `TGCLOUD_TOKEN` (`app<id>:<secret>`, required) and `OWNER_ID` (your numeric Telegram user ID, optional — recommended for automatic zero-touch owner seeding).
4. **Deploy & Claim Ownership:** Run the GitHub Actions deploy workflow (or push a commit). If you set `OWNER_ID`, send `/start` in private chat immediately; if you omitted `OWNER_ID`, send `/setbotowner` right away to claim ownership out of fail-closed Zero-State.

**Need optional Storage, Log, or Force-Join channels, or local `@tgcloud/cli` deployment (Bash, CMD, and PowerShell)?** See the [Setup & Deployment Guide](https://azipa.github.io/projects/telegram-uploader-bot/setup/).

## Key Features

- **Single & Batch Uploads with Storage Mirroring:** Upload single files or batches of up to 25 items across 8 media types (`photo`, `document`, `video`, `audio`, `voice`, `video_note`, `animation`, `sticker`) with dynamic owner allowlists and optional Storage Channel `copyMessages` fallback when a `file_id` reference expires.
- **Chunked Delivery, Protection & Ephemeral Controls:** Deliver bundles in 10-item pages via Telegram deep links with native `protect_content` (auto-upgraded to 36-character UUID v4 links), auto-delete timers, bundle TTL expiration, and one-time burn bundles.
- **Auto-Rotating Links & Live Channel Sync:** Manually or automatically rotate shared bundle links on a schedule while updating inline download buttons on published channel posts in real time.
- **Multi-Channel Force-Join & Community Voting:** Enforce up to 8 mandatory join channels checked in parallel waves with click cooldowns, plus per-bundle like/dislike voting and self-healing custom emoji support.
- **5-Level RBAC, Security & Owner Controls:** Owner, SuperAdmin, Admin, VIP (unlimited downloads), and User roles with fail-closed private-chat guards, rate limiting and ban/lockout checks, two-step ownership transfer, JSON config import/export, and an owner-only SQLite console.
- **100% Native Telegram Serverless + Bilingual UI:** Zero runtime `node_modules`, a 21-table built-in SQLite ledger for idempotent uploads and deliveries, and 272-key English/Persian localization.

## Full Documentation Hub

| Guide | Covers |
|---|---|
| [Overview & Highlights](https://azipa.github.io/projects/telegram-uploader-bot/) | Core capabilities, serverless execution model, and edition comparison |
| [Setup & Deployment](https://azipa.github.io/projects/telegram-uploader-bot/setup/) | BotFather Serverless setup, CI secrets, optional channels, and local `@tgcloud/cli` (Bash, CMD, PowerShell) |
| [Uploads, Delivery & Protection](https://azipa.github.io/projects/telegram-uploader-bot/features-delivery/) | Batch uploads, 10-item paging, `protect_content`, burn/TTL links, and auto-rotation |
| [Roles, Security & Operations](https://azipa.github.io/projects/telegram-uploader-bot/roles-security/) | 5-level RBAC, Zero-State claim, force-join gates, maintenance mode, and ownership transfer |
| [Commands & Configuration](https://azipa.github.io/projects/telegram-uploader-bot/commands-config/) | Full command reference, inline hubs, sparse `bot_config` JSON, and owner SQL console |
| [Architecture & SQLite Schema](https://azipa.github.io/projects/telegram-uploader-bot/architecture/) | 3 serverless handlers, idempotent upload/delivery ledgers, and all 21 SQLite tables |

## License

Licensed under the [Mozilla Public License 2.0 (MPL-2.0)](./LICENSE).
