# CLAUDE.md

Guidance for AI coding agents (Claude Code etc.) working in this repository.

## What this project is

**LINE Harness** — open-source CRM / marketing-automation platform for LINE Official Accounts (free alternative to paid LINE CRM SaaS). Step delivery, broadcasts, LIFF forms, rich menus, lead scoring, IF-THEN automation, affiliate tracking, multi-account with BAN detection, and an MCP server for AI-driven operation.

pnpm monorepo, TypeScript throughout. MIT license.

## Repository layout

```
apps/
  worker/    Backend — Hono app: REST API, LINE webhook receiver, LIFF pages, cron.
             Entry: src/index.ts (routes registered here). Node entry: src/node-server.ts.
             src/routes/    one file per API resource (+ colocated *.test.ts)
             src/services/  business logic (broadcast, dedup, booking, scoring, ...)
             src/middleware/, src/lib/, src/utils/, src/client/
  web/       Admin dashboard — Next.js 15, static export (output: 'export').
             src/app/<section>/ one directory per dashboard section (~30 sections).
             Talks to backend only via NEXT_PUBLIC_API_URL; no server-side code.
  liff/      LIFF (in-LINE) app — Vite + vanilla TS.
packages/
  db/        Database layer. schema.sql (D1/SQLite), postgres/migrations/*.sql (Postgres),
             src/ = typed query helpers (one file per domain), src/pg/adapter.ts =
             D1-style API (prepare().bind().all()/first()/run()) over a pg pool.
  sdk/               @line-harness/sdk — public typed API client (ESM+CJS, zero deps).
  mcp-server/        @line-harness/mcp-server — MCP server for Claude Code.
  line-sdk/          thin LINE Messaging API wrapper.
  shared/            shared types.
  create-line-harness/  setup CLI (Cloudflare one-command install).
  update-engine/     self-update engine (Cloudflare deploys only).
  plugin-template/   template for plugin extensions.
docs/      DOCKER.md, POSTGRES.md, DEPLOYMENT.md, ADMIN-AUTH.md, wiki/ (feature manuals,
           API/SDK reference), manual/
scripts/   release + sandbox tooling
```

## Two deployment targets (important)

The same backend code runs in two environments:

1. **Docker self-hosted (primary)** — Node process (`@hono/node-server`) + PostgreSQL 16 + MinIO (S3 API). `docker-compose.yml` at repo root; migrations auto-apply on boot via `packages/db/scripts/pg-migrate.mjs`. Cron jobs run in-process on a 5-minute schedule. See `docs/DOCKER.md`.
2. **Cloudflare (legacy, still supported)** — Workers + D1 + R2 + Pages, deployed by `create-line-harness` or wrangler. Cron via Workers triggers. See `docs/DEPLOYMENT.md`.

Consequences when changing code:
- **Database access goes through the D1-style API** (`prepare().bind().all()/first()/run()`). Never use `pg` directly in app code — the adapter (`packages/db/src/pg/adapter.ts`) keeps both backends working.
- **Schema changes need BOTH**: `packages/db/schema.sql` (D1) and a new numbered file in `packages/db/postgres/migrations/` (Postgres). Migrations are ordered, applied once, recorded in `schema_migrations`.
- **SQL must be valid on SQLite AND Postgres** (or branched per backend in the adapter/helpers).
- Cloudflare-only features (self-update `/admin/update/*`) runtime-guard on their env vars and are inert on Docker.
- Storage is S3-compatible via `@aws-sdk/client-s3` (`S3_*` env vars) — works against MinIO, AWS S3, and R2.

## Commands

```bash
pnpm install                     # Node >= 20, pnpm 9

# Dev
pnpm dev:worker                  # backend (vite dev)
pnpm dev:web                     # admin dashboard (next dev)
pnpm --filter worker start:node  # backend as Node process (needs Postgres, see below)

# Test (vitest everywhere; tests colocated as *.test.ts)
pnpm --filter worker test
pnpm --filter web test
pnpm --filter @line-crm/db test
pnpm --filter @line-harness/sdk test
pnpm test:scripts                # root scripts tests

# Typecheck / build
pnpm --filter worker typecheck
pnpm build                       # all packages

# Database
pnpm db:migrate:pg               # apply Postgres migrations (needs DATABASE_URL)
pnpm db:migrate                  # D1 (wrangler)

# Self-hosted stack
cp .env.example .env             # then set POSTGRES_PASSWORD, API_KEY, LINE_*, S3 keys
docker compose up -d --build     # backend + postgres + minio; health: :8787/api/health
```

## Conventions & gotchas

- **API responses**: `{"success": true, "data": ...}` / `{"success": false, "error": ...}` envelope.
- **Auth**: API key (`API_KEY`) for API/SDK/MCP; admin dashboard uses HttpOnly session cookies. Cross-site admin (Vercel/Pages ↔ backend) requires `ADMIN_ORIGIN` allowlist + `ADMIN_ALLOW_CROSS_SITE=true` (SameSite=None cookies). Details: `docs/ADMIN-AUTH.md`.
- **Staff roles**: Owner / Admin / Staff, each with own API keys.
- **apps/web is a static export** — no API routes, no server components with runtime data; everything fetches from the backend at `NEXT_PUBLIC_API_URL`. Its only env var is `NEXT_PUBLIC_API_URL`.
- **Route registration**: new API routes go in `apps/worker/src/routes/<resource>.ts` and are mounted in `apps/worker/src/index.ts`.
- **Tests colocated** next to source (`foo.ts` + `foo.test.ts`), run with vitest per package.
- **Env vars**: canonical list with comments in `.env.example`. `WORKER_URL` = the backend's own public URL (used to build webhook/LIFF links).
- **Multi-account** is a first-class concept — most domain tables/queries are scoped by LINE account; check for `account_id` scoping when touching queries.
- **Docs to update with behavior changes**: `docs/wiki/` feature pages and `docs/wiki/20-API-Reference.md` / `19-SDK-Reference.md`.
- READMEs: `README.md` (English, default) and `README.ja.md` (Japanese) — keep both in sync.
