# Release Notes

## v0.16.0 (2026-07-07)

### Added — Affiliate tracking (ASP)

Self-serve affiliate tracking with a full funnel timeline (click → friend add → form/booking → payment).

- **Self-serve links** — affiliates register and issue links from LIFF (`?page=affiliate`): 6-char random slugs, up to 20 links, per-channel labels. Admins can also create affiliates from the dashboard (server-generated random codes, 1:1 friend binding).
- **Offers** — define campaigns with a fixed reward per conversion. Affiliates enroll per offer and get offer-specific links; offer tags/scenarios are applied automatically on inflow (paused offers stop the flow, measurement continues).
- **Last-touch attribution** — the latest affiliate touch within a 90-day window is snapshotted at conversion time (self-clicks excluded). The full touch history stays queryable in `ref_tracking`.
- **Approval flow** — attributed conversions start as `pending`; approve/reject from the dashboard. Confirmed reward = approved count × fixed amount, with identity-key duplicate flags for fraud review.
- **Push notifications** — affiliates get a LINE push on new referred friend adds and on approval (double-send prevented at the DB level).
- **Journey APIs** — `GET /api/friends/:id/journey` and per-affiliate journeys with cursor pagination.
- **Short link domain** — `LINK_BASE_URL` account setting + a redirect rule on your domain yields `https://<your-domain>/<slug>` links.
- Admin UI consolidated into one `/affiliates` page with three tabs (affiliates / offers / approvals); the LIFF page follows the booking form design language.

### Added — iOS proxy booking

- Admin proxy booking and availability routes for the iOS app flow.

### Improved — Chat & inbox

- **~8x faster chat list** — replaced triple `messages_log` scans with argmax aggregation and added cursor pagination (production: 3,473ms → 435ms).
- **Unanswered badge** — conversations marked resolved are excluded (auto-revive on new inbound); instant refresh after replies/status changes; non-text inbound (images/stickers) now marks chats unread.
- The same resolved exclusion now applies to `/api/conversations` and the MCP `list_conversations` tool.

### Fixed

- Booking reminders run before heavy scheduled jobs (prevents cron-starvation misses) and after token refresh.
- `/o` share URLs return OGP HTML to link-preview bots; cross-account OGP fallback leak fixed.
- Update banner: hidden for builds without embedded versions (self-hosted CI/CD), softer fork wording, manual-update guide link fixed (`docs/wiki/26-Manual-Update.md`).
- `/updates` page shows guidance instead of "Failed to fetch" when self-update is not configured.

### Database

- Migrations `046_affiliate_links.sql` and `047_affiliate_offers.sql` (both additive; 047 backfills `pending` for existing attributed conversions).

## v0.14.1 (2026-05-20)

Patch release for the OSS sync line from the private `line-harness` repository.

### Changed

- Synced the latest allowlisted worker updates from private `line-harness` into `line-harness-oss`.
- Kept OSS-specific CI and regression guards intact during the sync.
- Cleaned up update-route typing and removed unused LIFF event booking aliases.

### Verification

- `pnpm --filter worker typecheck`
- `pnpm --filter worker test`
- `pnpm --filter worker build`

### Notes

- The sync does not delete OSS-only files. Paths reported by `harness-oss-sync` as `would_delete_manual` remain manual review items.
- Private uncommitted reminder-dedup work was not included; this release was prepared from private `HEAD`.
