🌐 **English** | [日本語](README.ja.md)

# LINE Harness

> ### **[Try it free on LINE](https://shudesu.github.io/line-harness-oss/)** 👈

A fully open-source CRM for LINE Official Accounts — a **free alternative to paid LINE CRM SaaS** (typically ¥10,000–20,000+/month). Step delivery, broadcasts, forms, rich menus, scoring, automation, multi-account management, and full Claude Code (AI) integration.

**Current version**: v0.17.0 ・ MIT License ・ TypeScript

---

## Why LINE Harness?

| | Paid SaaS A | Paid SaaS B | **LINE Harness** |
|---|---|---|---|
| Monthly cost | ¥20,000+ | ¥10,000+ | **$0** |
| Step messaging | ✅ | ✅ | ✅ |
| Segment broadcasts | ✅ | ✅ | ✅ |
| Rich menu switching | ✅ | ✅ | ✅ |
| Forms (LIFF) | ✅ | ✅ | ✅ |
| Lead scoring | ✅ | ❌ | ✅ |
| IF-THEN automation | partial | partial | ✅ |
| Public API | ❌ | ❌ | **all features** |
| Claude Code (AI) integration | ❌ | ❌ | **MCP server included** |
| BAN detection & account migration | ❌ | ❌ | **✅** |
| Multi-account | extra contract | extra contract | **built-in** |
| Friend deduplication | ❌ | ❌ | **✅** (cross-account, picture token matching) |
| Source code | closed | closed | **MIT (this repo)** |

---

## Architecture

LINE Harness has two runtime pieces:

```
[ LINE Platform ] ⇄ [ Backend: Hono API (apps/worker) ] ⇄ [ PostgreSQL ]
                                  ⇅                          [ MinIO / S3 ]
                     [ Admin dashboard: Next.js (apps/web) ]
                                  ⇅
                     [ MCP Server / SDK / Claude Code ]
```

- **Backend** (`apps/worker`) — Hono app: REST API, LINE webhook receiver, LIFF pages, and in-process cron (step delivery, broadcasts, reminders). Runs as a Node.js process in Docker with PostgreSQL and MinIO (S3-compatible object storage). A legacy Cloudflare Workers + D1 + R2 deployment path also exists (`docs/DEPLOYMENT.md`).
- **Admin dashboard** (`apps/web`) — Next.js 15 static export. Talks to the backend over `NEXT_PUBLIC_API_URL`. Host it on Vercel (recommended, see below) or Cloudflare Pages; the Docker backend also serves the SPA itself at its root URL.

---

## Backend: deploy with Docker Compose

Full guide: [docs/DOCKER.md](docs/DOCKER.md)

### Prerequisites

- A VPS (or any host) with Docker + Docker Compose
- A LINE Official Account with a Messaging API channel ([LINE Developers console](https://developers.line.biz/))
- A domain name — LINE only delivers webhooks to valid HTTPS endpoints

### Steps

```bash
git clone https://github.com/devs-nimm/line-harness-oss.git
cd line-harness-oss

cp .env.example .env
# edit .env — see the variable table below

docker compose up -d --build
curl http://localhost:8787/api/health
# → {"success":true,"data":{"status":"ok"}}
```

This starts three services:

| Service | What | Port (host) |
|---|---|---|
| `backend` | Hono app on Node — API + admin SPA | `${BACKEND_PORT:-8787}` |
| `postgres` | PostgreSQL 16 (database) | `${POSTGRES_PORT:-5432}` |
| `minio` | S3-compatible object storage (images) | 9000 / console 9001 |

Schema migrations apply automatically on every container boot (idempotent) — no manual migration step.

### TLS reverse proxy (required)

Put a reverse proxy with a real certificate in front of the backend. Caddy is the least-effort option:

```
# /etc/caddy/Caddyfile
line.example.com {
    reverse_proxy localhost:8787
}
```

Then:

1. Point DNS `line.example.com` → your server.
2. Set `WORKER_URL=https://line.example.com` in `.env` and run `docker compose up -d` again.
3. In the LINE Developers console (Messaging API → Webhook settings), set the webhook URL to `https://line.example.com/webhook` and verify.

### Backend `.env` variables

Required — the stack will not work without these:

| Variable | What |
|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL password. Also update it inside `DATABASE_URL`. |
| `API_KEY` | Admin/API key for the dashboard, SDK, and MCP server. Pick a long random string. |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel access token (LINE Developers console). |
| `LINE_CHANNEL_SECRET` | Messaging API channel secret (LINE Developers console). |
| `WORKER_URL` | Public HTTPS URL of the backend, e.g. `https://line.example.com`. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Object-storage credentials. Change from the `minioadmin` defaults; these also become MinIO's root user/password. |

Common optional:

| Variable | What |
|---|---|
| `ADMIN_ORIGIN` | Comma-separated allowlist of admin-dashboard origins (no trailing slash), e.g. `https://your-admin.vercel.app`. Needed when the dashboard is hosted on a different domain (Vercel/Pages). |
| `ADMIN_ALLOW_CROSS_SITE` | `true` when admin and API are on different sites (Vercel ↔ VPS) — issues `SameSite=None; Secure` session cookies. |
| `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` | LINE Login channel, used by LIFF forms/auth. |
| `LIFF_URL` | Your LIFF app URL (`https://liff.line.me/<liff-id>`). |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_FORCE_PATH_STYLE` | Object-storage location. Defaults target the bundled MinIO; point at AWS S3/R2 instead if you prefer. |
| `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PORT` / `DATABASE_URL` | Database identity/connection. `DATABASE_URL` as written in `.env` is only used when running the backend on the host; inside docker-compose it is overridden to point at the `postgres` service. |
| `BACKEND_PORT` | Host port the backend is published on (container listens on 8787). |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI-compatible chat auto-reply. Values here override the admin-UI global settings per variable. |
| `STRIPE_WEBHOOK_SECRET` | Only if you use the Stripe webhook-in integration. |
| `X_HARNESS_URL` | Optional cross-Harness account linking. |

### Updating

```bash
git pull
docker compose up -d --build   # migrations apply automatically on boot
```

### Backups

The named volumes `pgdata` and `minio-data` are the only state — back them up together:

```bash
docker compose exec postgres pg_dump -U postgres linecrm | gzip > backup.sql.gz
# plus a copy/rclone sync of the minio-data volume
```

---

## Frontend (Admin): deploy on Vercel

The admin dashboard is a plain Next.js static export, so it deploys to Vercel with no server config. Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (Method 4).

1. **Create the Vercel project** — dashboard → *Add New → Project*, import this repo, and set:
   - **Root Directory**: `apps/web` (keep "Include source files outside of the Root Directory" enabled — the build needs the workspace packages)
   - **Framework Preset**: Next.js (auto-detected)
2. **Set the environment variable on the Vercel dashboard** (*Project → Settings → Environment Variables*):

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | Your backend's public HTTPS URL, e.g. `https://line.example.com` — no trailing slash |

   This is the **only** env var the frontend needs.
3. **Allow the Vercel origin on the backend** — in the backend `.env`:

   ```bash
   ADMIN_ORIGIN=https://your-admin.vercel.app
   ADMIN_ALLOW_CROSS_SITE=true
   ```

   then `docker compose up -d` to restart.
4. **Deploy.** Vercel builds on every push to the production branch.

---

## Alternative: Cloudflare one-command setup

The original Cloudflare deployment (Workers + D1 + R2 + Pages, free tier) still works:

```bash
npx create-line-harness
```

The CLI handles Cloudflare auth, D1 creation + migrations, Worker/dashboard deploys, LINE credentials, LIFF app creation, and the initial Owner user (~5 min). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Key features

### Delivery
- **Step campaigns** — minute-level `delay_minutes` control, conditional branching, stealth sends
- **Broadcasts** — all / tag / segment targeting, immediate or scheduled, auto-queued past 500 recipients
- **Reminders** — countdown delivery toward a target date (3 days before / 1 day before / day-of)
- **Templates** — personalization with `{{name}}` `{{uid}}` `{{auth_url:CHANNEL_ID}}`
- **Tracked links** — click measurement → auto-tagging → scenario triggers

### CRM
- **Friend management** — auto-registration via webhook, profile capture, custom metadata
- **Tags & scoring** — delivery conditions, scenario triggers, behavior-based lead scores
- **Operator chat & Conversation Inbox** — 1:1 replies from the dashboard, unanswered conversations sorted by idle time
- **Duplicate detection** — same user across multiple accounts auto-tagged via `picture_url` token matching

### Marketing
- **Rich menus** — automatic per-user / per-tag switching
- **Forms (LIFF)** — in-LINE forms, answers saved to metadata automatically
- **Calendar booking** — Google Calendar-backed booking (LIFF)
- **Staff management** — Owner / Admin / Staff roles with individual API keys

### Affiliate tracking (ASP)
- Affiliate link issuing (one tap from LIFF), per-offer fixed rewards, click → friend-add → CV timeline tracking with last-touch attribution, approval flow, LINE push on confirmation. Details: [docs/wiki/27-Affiliate-ASP.md](docs/wiki/27-Affiliate-ASP.md)

### Automation
- **IF-THEN rules** — 7 trigger types × 6 action types
- **Auto-replies** — exact / partial keyword match
- **Webhook IN/OUT** — Stripe, Slack, and other external integrations
- **Notification rules** — conditional alerts

### Multi-account
- Multiple LINE Official Accounts in one dashboard, per-account scenarios/tags/broadcasts, **BAN detection** with automatic friend migration to the next account, traffic pooling

### AI integration
- **MCP server included** (`@line-harness/mcp-server`) — operate everything from Claude Code in natural language
- **Typed SDK** (`@line-harness/sdk`) — TypeScript, ESM + CJS, zero dependencies

---

## Documentation

- [Docker self-hosting guide](docs/DOCKER.md) ・ [PostgreSQL guide](docs/POSTGRES.md) ・ [Deployment guide](docs/DEPLOYMENT.md)
- [Wiki](docs/wiki/Home.md) — feature-by-feature manuals, API/SDK reference
- npm: [@line-harness/sdk](https://www.npmjs.com/package/@line-harness/sdk) ・ [@line-harness/mcp-server](https://www.npmjs.com/package/@line-harness/mcp-server) ・ [create-line-harness](https://www.npmjs.com/package/create-line-harness)

---

## License

MIT — free for commercial use, modification, and redistribution.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

**Shuichi Noda (Shudesu)** — creator of the Harness series (LINE / IG / X Harness), CEO of AI Agent Inc.

- GitHub: [@Shudesu](https://github.com/Shudesu) ・ X: [@ai_shunoda](https://x.com/ai_shunoda)
- Docs: [Harness Wiki](https://harness-wiki.pages.dev) ・ Pricing comparisons: [The Harness Lab](https://the-harness.com)

> **LINE Harness** — the open-source LINE CRM for the AI-native era
