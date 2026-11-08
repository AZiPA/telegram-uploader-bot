# Telegram FileStore Bot (Telegram Serverless Edition)

[🇮🇷 مطالعه راهنمای فارسی (Persian Documentation)](./README.fa.md)

Serverless Telegram file storage and sharing bot, powered by @tgcloud/bot. Version **1.0.0**.

> [!TIP]
> **Prefer Cloudflare Workers + D1?**
> Check out the sister repository: [telegram-filestore-bot](https://github.com/your-org/telegram-filestore-bot) for the Cloudflare Workers + D1 SQL database edition.

---

## Overview & Zero-Cost Architecture

Serverless Telegram file storage and sharing bot, powered by @tgcloud/bot. This edition runs 100% inside Telegram's native serverless runtime (`@tgcloud/bot`). It requires:
- **Zero VPS or external servers**
- **Zero external cloud hosting fees**
- **Zero `node_modules` at runtime** (strictly powered by built-in `'sdk'`, `'sdk/db'`, and `'sdk/api'`)
- **Zero `process.env` dependencies** (all operational settings persist dynamically in `system_config`)

Files never pass through or buffer inside the bot. Delivery uses direct Telegram `file_id` or bulk `copyMessages` from your optional storage channel.

```mermaid
flowchart LR
  TG[Telegram Serverless Runtime]
  DB[(Telegram Serverless DB)]
  Guard[command_guard.js<br/>Auth & Maintenance]
  Core[FileStore Core Engine]
  API[Telegram Bot API]

  TG -->|handlers/message.js, callback_query.js, my_chat_member.js| Guard
  Guard -->|Authorized & Active| Core
  Core -->|sdk/db| DB
  Core -->|sdk/api| API
```

---

## Key Features & Engineering Architecture

### Core FileStore Capabilities
- **Single & Batch Uploads:** Upload individual files or send multiple files with `/batch` and `/done` (up to 25 items per bundle).
- **Chunked File Delivery:** Automatic pagination in chunks of 10 items with progress tracking and deep linking (`t.me/YourBot?start=CODE`).
- **Expiring & One-Time Bundles:** Auto-expiring bundles (1h, 6h, 12h, 24h, 48h) and one-time burn-after-download bundles (`is_one_time`).
- **Content Protection & Forward-Locking:** Telegram-native forward prevention (`protect_content: true`) and high-entropy unguessable 122-bit UUID v4 links for secure sharing.
- **Opportunistic Link Rotation:** Automatic high-entropy code regeneration (8-char Base62 regular / 36-char UUID protected) on interval presets (6h, 12h, 24h, 48h) and auto-deletion, processed opportunistically on incoming updates with live channel post button updating.
- **Opt-in Hierarchical Ownership:** Shared admin collaboration by default, with hierarchical locking (`owner_locked`) preventing lower-ranked admins from modifying sensitive bundles.
- **Channel Membership Verification (Force-Join):** Require users to join up to 8 channels (`MAX_FORCE_JOIN_CHANNELS = 8`) before accessing files, verified concurrently in waves of at most 6 outgoing requests. Bot-managed invite links are created and revoked strictly during admin setup or renewal, never during user membership checks.
- **Admin Hub & Live Management:** Interactive inline GUI (`/edit`, `/manage`, `/review`) for editing titles, toggling protections, previewing delivery, or deleting items.

### Recent Architecture & Security Enhancements
1. **SQL Injection Immunity via Native Drizzle ORM Prepared Statements:** All database queries utilize type-safe parameterized inputs (`sdk/db`) with built-in ORM sanitization, preventing any SQL injection vulnerabilities.
2. **Complete HTML Injection Prevention & Telegram Entity Sanitization:** Comprehensive escaping of all dynamic text, file metadata, user strings, and error messages via `escapeHtml()` prior to Telegram HTML parse mode rendering.
3. **Native i18n Architecture with 100% Token/Key Parity:** Dual-language localization (`en` and `fa`) verified by automated test suites ensuring zero missing translation keys or broken `{placeholder}` tokens across all 254 keys.
4. **Clean Session-based FSM + Telegram ForceReply:** Interactive user/admin workflows (bot profile editing, admin assignment, custom channel labels) rely on clean session state machines in the database with strict TTLs and native Telegram `force_reply`, completely retiring legacy hashtag text markers.
5. **Strict Owner-only Maintenance Mode:** Instant platform lockdown (`/maintenance`) that immediately blocks non-owner commands and callback queries before core execution, allowing safe migrations, schema updates, and administrative maintenance.
6. **In-Memory TTL Cache (15s):** Micro-caching for admin access privileges (`getAdmins`) and dynamic configuration parameters (`getConfig`), eliminating repetitive SQLite database round-trips on updates and callback queries.
7. **Atomic Compare-And-Swap (CAS) Maintenance:** Concurrency-safe opportunistic background maintenance (`last_maint_at`) preventing duplicate execution waves and rate-limit hits across parallel V8 isolates.
8. **Non-Destructive Passive Force-Join Checks:** Pure `getChatMember` membership validation; bot-managed invite links are created/revoked strictly during admin setup or renewal, never during user membership checks.
9. **Bounded Memory Eviction Guards:** Automatic pruning on internal throttle maps (`strikeMap`) preventing unbounded memory growth in warm serverless isolate lifecycles.

---

## Repository Structure

```
telegram-filestore-tgcloud/
├── tgcloud/
│   ├── schema.js               # 11-table database schema with @tgcloud/bot ORM DSL
│   ├── handlers/
│   │   ├── message.js          # Inbound message routing, Zero-State exception & guard checks
│   │   ├── callback_query.js   # Inline callback routing, Zero-State exception & guard checks
│   │   └── my_chat_member.js   # Bot membership and status updates in channels/groups
│   └── lib/
│       ├── helpers.js          # Core DRY helpers (sendMsg, editMsg, editMarkup, answerCq, etc.)
│       ├── admin/
│       │   ├── admins.js       # Admin role grant, revoke, and listing logic
│       │   ├── factory_reset.js# Core atomic reset procedures and table truncations
│       │   ├── index.js        # Admin command dispatcher & menu routing
│       │   ├── maintenance.js  # Owner-only maintenance mode toggle & checks
│       │   ├── members.js      # Staff list & admin/VIP promotion/demotion
│       │   ├── members_panel.js# Staff management inline keyboards & panels
│       │   ├── owner.js        # Root ownership assignment (/setbotowner) & transfer
│       │   ├── ownership_bootstrap.js # Zero-State claim & CI/CD owner enforcement
│       │   ├── ownership_transfer.js  # Two-step ownership transfer & token management
│       │   ├── profile.js      # Bot profile (name, about, description) state machine
│       │   ├── profile_panel.js# Bot profile configuration keyboards
│       │   ├── settings.js     # System settings handlers (quotas, TTLs, protections)
│       │   ├── settings_panel.js# Settings inline GUI panels
│       │   ├── sql_console.js  # Interactive SQL console for system owners
│       │   └── stats.js        # Analytics & download metrics calculations
│       ├── bundles/
│       │   ├── deletion.js     # Bundle removal & cascading cleanup
│       │   ├── expiry.js       # Expiry threshold calculations and auto-purge logic
│       │   ├── hub_panel.js    # Interactive Bundle Hub panel & action buttons
│       │   ├── index.js        # Bundle router & entrypoint
│       │   ├── permissions.js  # Hierarchical owner-lock permission guards
│       │   ├── pin.js          # Legacy PIN stub (retained for backward compatibility)
│       │   ├── protected.js    # Protected content & link access management
│       │   ├── review_panel.js # Individual bundle item inspection & deletion GUI
│       │   ├── rotation.js     # Opportunistic link rotation & channel post updates
│       │   └── setname.js      # Interactive bundle renaming workflow
│       ├── db/
│       │   ├── schema.js       # Drizzle SQLite core table definition (bot_config)
│       │   └── migrations.js   # Bootstrap DDL migration script for bot_config
│       ├── core/
│       │   ├── background.js   # Opportunistic background maintenance runner
│       │   └── router.js       # Central message & callback query router
│       ├── filestore/
│       │   ├── delivery.js     # Chunked file delivery (up to 25 items) with pagination
│       │   ├── search.js       # Bundle search by title
│       │   ├── unlock.js       # User ban verification & access gatekeeping
│       │   ├── upload.js       # Single & batch (/batch) file upload pipeline
│       │   └── voting.js       # Community bundle upvote/downvote handling
│       ├── force_join/
│       │   ├── handlers.js     # Force-join command & callback query dispatchers
│       │   ├── panel.js        # Force-join management GUI & channel listings
│       │   ├── service.js      # Multi-channel membership verification service (up to 8 channels)
│       │   └── wizards.js      # Channel addition & custom button label wizards
│       ├── locales/
│       │   ├── en.js           # English i18n locale dictionary (254 keys)
│       │   ├── fa.js           # Persian i18n locale dictionary (Rule 14 isolated, 254 keys)
│       │   └── index.js        # Dynamic locale resolver & string interpolator
│       ├── middlewares/
│       │   ├── auth.js         # Role authentication & authorization guards
│       │   ├── command_guard.js# Command rate-limiting & maintenance guard
│       │   ├── rate_limiter.js # Sliding-window rate limiter & strike tracking
│       │   └── roles/
│       │       ├── admin.js       # Role Level 2 permission checks
│       │       ├── owner.js       # Role Level 4 permission checks
│       │       ├── public.js      # Public user permission checks and rate-limit gatekeeping
│       │       └── super_admin.js # Role Level 3 permission checks and administrative access control
│       ├── services/
│       │   ├── log_channel.js  # Security audit and activity logging service
│       │   ├── media_config.js # Dynamic media type toggles
│       │   └── storage_channel.js # Mirror storage channel sync service
│       └── shared/
│           ├── buttons.js      # Reusable Telegram inline keyboard builders
│           ├── config.js       # Dynamic system configuration cache (system_config)
│           ├── config_service.js # Declarative config loader, deep-merging, prototype guard & sparse diff
│           ├── constants.js    # Operational limits, defaults, and timeouts
│           ├── crypto.js       # High-entropy tokens, hashing & Web Crypto utilities
│           ├── default_config.js # Baseline static configuration defaults
│           ├── emojis.js       # Custom emoji renderer & self-healing circuit breaker
│           ├── formatters.js   # HTML escaping & entity formatters
│           ├── sessions.js     # Session state machine helpers
│           └── telegram.js     # Low-level Telegram Bot API wrappers
├── scripts/
│   └── patch-snapshot.mjs      # Post-install CLI snapshot compatibility patcher
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions CI/CD deploying via @tgcloud/cli
└── package.json
```

---

## Database Schema Documentation

The database schema is defined in `tgcloud/schema.js` using `@tgcloud/bot` ORM DSL:

| Table | Description |
|---|---|
| `bundles` | Bundle metadata, file items JSON array (up to 25 files), creator ID, expiration timestamps, one-time burn flags, and auto-rotation settings. |
| `admin_sessions` | Handles admin interactive sessions (profile editing, channel labels, adding admins) with 300s TTL and Command Breakout. |
| `user_sessions` | Retained session table for safe backward schema migrations across deployments. |
| `system_config` | Key-value store for system settings (`owner_id`, storage channel, log channel, maintenance mode, daily download limits, default language). |
| `admins` | Administrative roster and hierarchical roles (`admin`, `super_admin`). |
| `vips` | VIP subscriber list with expiration dates and quota/force-join exemptions. |
| `force_channels` | Required force-join channels, invite links, custom button labels, and member limits. |
| `user_quotas` | User rate-limiting, daily download quotas, request timestamps, durable strike tracking (5-strike lockout), and ban expirations. |
| `user_downloads` | Download audit history tracking user access per bundle code per calendar day. |
| `bundle_votes` | User feedback records (upvotes/downvotes) per bundle code. |
| `deletion_queue` | Ephemeral message deletion queue processed during opportunistic maintenance passes. |
| `bot_config` | Single-row sparse JSON override table (`id = 'active'`) storing divergences from `tgcloud/lib/shared/default_config.js`. |

---

## Deployment & Configuration

### Zero-State Bootstrap Flow

You do **not** need to hardcode `OWNER_ID` into environment variables or source code:
1. **Cold Start (Zero-State):** When deployed on a fresh database where no owner exists in `system_config`, the bot automatically enters **Zero-State**.
2. **Interactive Initialization or Zero-Touch CI Seeding:**
   - **Interactive:** In Zero-State, all general commands and media processing are gated except `/setbotowner` (and alias `/ermia`). The root owner initializes ownership interactively by executing `/setbotowner` in private chat.
   - **Zero-Touch CI Seeding:** Alternatively, provide the optional `OWNER_ID` secret in GitHub Actions repository secrets; CI will automatically execute initial database bootstrap during deployment.
3. **Lockdown & Management:** Once claimed, ownership is securely written to `system_config`. The owner can now configure channels, promote admins, adjust settings, or initiate two-step ownership transfer (`/transfer_ownership <target_id>`) at any time.

### Zero-Env Configuration

Telegram Serverless does not use `process.env`. All operational parameters are maintained in `system_config` and managed dynamically via bot commands:
- Storage channel: `/setstoragechannel <-100...|off|clear>`
- Security log channel: `/setlogchannel <-100...|off|clear>`
- Ownership transfer: `/transfer_ownership <user_id>` (two-step DB-backed flow with 60s confirmation token & zero-privilege revocation)
- Maintenance mode: `/maintenance`
- System language: `/setlang`
- Daily quotas & TTLs: `/settings`
- Export configuration: `/export_config` (Owner-only Level 4, outputs active JSON configuration)
- Import configuration: `/import_config <json>` (Owner-only Level 4, deep merges and validates sparse JSON overrides)

The bot's username is retrieved automatically at runtime via `api.getMe()`.

### Deployment Methods

#### Option 1: Automated GitHub Actions CI/CD (Recommended)

Deployment is fully automated using `@tgcloud/cli` via GitHub Actions (`.github/workflows/deploy.yml`):
1. Fork or push this repository to GitHub.
2. In your repository settings (**Settings > Secrets and variables > Actions**), configure your repository secrets:
   - `TGCLOUD_TOKEN`: The sole required Telegram Serverless CLI access token (scoped strictly to CLI deployment steps in `.github/workflows/deploy.yml`).
   - `OWNER_ID`: (Optional) Numeric Telegram User ID for automated zero-touch initial owner bootstrap during deployment.
3. Pushing to `main` triggers `.github/workflows/deploy.yml`, which:
   - Installs `@tgcloud/cli` via `npm install --no-audit --no-fund`.
   - Fetches current cloud state (`tgcloud fetch`).
   - Pushes updated modules (`tgcloud push`).
   - Applies safe non-destructive database migrations (`tgcloud migrate --safe`).
   - Synchronizes webhooks (`tgcloud webhook sync`).
   - Seeds initial bot owner if `OWNER_ID` secret is present.

#### Option 2: Local Deployment via `@tgcloud/cli`

1. Install dependencies:
   ```bash
   npm install
   ```

2. Deploy via CLI:
   ```bash
   npx @tgcloud/cli push
   npx @tgcloud/cli migrate --safe
   npx @tgcloud/cli webhook sync
   ```

---

## Commands & User Roles

### Role Hierarchy
- **Owner (Level 4):** Root superuser. Full system access, bypasses maintenance mode, executes `/setbotowner` and `/factoryreset`, and unlocks owner-locked bundles.
- **SuperAdmin (Level 3):** High-level administrator. Can add/remove regular admins and manage standard bundles.
- **Admin (Level 2):** Operational staff. Can upload files, create bundles, manage force-join channels, configure settings, and view analytics.
- **VIP (Level 1):** Subscriber role. Enjoys unlimited file downloads and bypasses mandatory force-join channel checks.
- **User (Level 0):** Standard end-user. Subject to daily download quotas and mandatory channel memberships.

### Key Commands
- `/start` or `/start <code>`: Access file bundles or start the bot.
- `/setbotowner` (or `/ermia`): Claim ownership during Zero-State or transfer ownership (owner-only).
- `/setstoragechannel <-100...|off|clear>`: Set or remove the private mirror storage channel.
- `/setlogchannel <-100...|off|clear>`: Set or remove the administrative security log channel.
- `/batch`: Start an interactive multi-file upload session (send up to 25 files, then `/done`).
- `/manage <code>` or `/edit <code>`: Open the interactive Bundle Hub.
- `/review <code>`: View item list with individual file deletion buttons.
- `/channels`: Manage mandatory Force-Join channels.
- `/admins`: Manage administrator roster and permissions.
- `/vips`: List, add, and remove VIP subscribers.
- `/stats`: View bot usage and download analytics.
- `/settings`: Configure daily download quotas, bundle TTL, and default protections.
- `/maintenance`: Toggle strict owner-only maintenance mode.
- `/botprofile`: Modify bot name, description, and short description directly.
- `/setlang`: Change UI language (`English` or `فارسی`).

---

## License

MPL-2.0 license.
