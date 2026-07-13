🌐 [English](README.md) | **日本語**

# LINE Harness

> ### **[LINE で無料体験する](https://shudesu.github.io/line-harness-oss/)** 👈

LINE 公式アカウントの完全オープンソース CRM。**有料 LINE CRM SaaS（月額 1〜2 万円〜）の無料代替**。
ステップ配信・ブロードキャスト・フォーム・リッチメニュー・スコアリング・自動化・マルチアカウント、そして Claude Code (AI) 完全対応。

**現バージョン**: v0.17.0 ・ MIT License ・ TypeScript

---

## なぜ LINE Harness？

| | L社 | U社 | **LINE Harness** |
|---|---|---|---|
| 月額 | 2万円〜 | 1万円〜 | **0円** |
| ステップ配信 | ✅ | ✅ | ✅ |
| セグメント配信 | ✅ | ✅ | ✅ |
| リッチメニュー切替 | ✅ | ✅ | ✅ |
| フォーム (LIFF) | ✅ | ✅ | ✅ |
| スコアリング | ✅ | ❌ | ✅ |
| IF-THEN 自動化 | 一部 | 一部 | ✅ |
| API 公開 | ❌ | ❌ | **全機能** |
| Claude Code (AI) 対応 | ❌ | ❌ | **MCP server 同梱** |
| BAN 検知 & 自動アカウント切替 | ❌ | ❌ | **✅** |
| マルチアカウント | 別契約 | 別契約 | **標準搭載** |
| 友だち重複検出 | ❌ | ❌ | **✅** (picture_url トークン照合) |
| ソースコード | 非公開 | 非公開 | **MIT (このリポ)** |

---

## アーキテクチャ

LINE Harness は 2 つのランタイムで構成されます:

```
[ LINE Platform ] ⇄ [ バックエンド: Hono API (apps/worker) ] ⇄ [ PostgreSQL ]
                                  ⇅                             [ MinIO / S3 ]
                     [ 管理画面: Next.js (apps/web) ]
                                  ⇅
                     [ MCP Server / SDK / Claude Code ]
```

- **バックエンド** (`apps/worker`) — Hono アプリ。REST API、LINE Webhook 受信、LIFF ページ、プロセス内 cron（ステップ配信・ブロードキャスト・リマインダー）。Docker 上の Node.js プロセスとして PostgreSQL + MinIO（S3 互換ストレージ）と一緒に動作。従来の Cloudflare Workers + D1 + R2 構成も利用可能（`docs/DEPLOYMENT.md`）。
- **管理画面** (`apps/web`) — Next.js 15 静的エクスポート。`NEXT_PUBLIC_API_URL` 経由でバックエンドと通信。Vercel（推奨・下記参照）または Cloudflare Pages でホスト可能。Docker バックエンド自身もルート URL で SPA を配信します。

---

## バックエンド: Docker Compose でデプロイ

詳細ガイド: [docs/DOCKER.md](docs/DOCKER.md)

### 必要なもの

- Docker + Docker Compose が使える VPS（または任意のホスト）
- LINE 公式アカウント + Messaging API チャネル（[LINE Developers コンソール](https://developers.line.biz/)）
- ドメイン — LINE の Webhook は有効な HTTPS エンドポイントにしか配信されません

### 手順

```bash
git clone https://github.com/devs-nimm/line-harness-oss.git
cd line-harness-oss

cp .env.example .env
# .env を編集 — 下の変数表を参照

docker compose up -d --build
curl http://localhost:8787/api/health
# → {"success":true,"data":{"status":"ok"}}
```

以下の 3 サービスが起動します:

| サービス | 内容 | ポート (ホスト) |
|---|---|---|
| `backend` | Node 上の Hono アプリ — API + 管理 SPA | `${BACKEND_PORT:-8787}` |
| `postgres` | PostgreSQL 16（データベース） | `${POSTGRES_PORT:-5432}` |
| `minio` | S3 互換オブジェクトストレージ（画像） | 9000 / コンソール 9001 |

スキーマのマイグレーションはコンテナ起動時に毎回自動適用（冪等）— 手動のマイグレーション作業は不要です。

### TLS リバースプロキシ（必須）

有効な証明書を持つリバースプロキシをバックエンドの前段に置いてください。Caddy が最も手軽です:

```
# /etc/caddy/Caddyfile
line.example.com {
    reverse_proxy localhost:8787
}
```

その後:

1. DNS で `line.example.com` → サーバーに向ける。
2. `.env` の `WORKER_URL=https://line.example.com` を設定し、再度 `docker compose up -d`。
3. LINE Developers コンソール（Messaging API → Webhook 設定）で Webhook URL を `https://line.example.com/webhook` に設定し、検証。

### バックエンド `.env` 変数

必須 — これらがないと動作しません:

| 変数 | 内容 |
|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL パスワード。`DATABASE_URL` 内も合わせて更新。 |
| `API_KEY` | 管理画面・SDK・MCP server 用の API キー。長いランダム文字列を推奨。 |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API チャネルアクセストークン（LINE Developers コンソール）。 |
| `LINE_CHANNEL_SECRET` | Messaging API チャネルシークレット（LINE Developers コンソール）。 |
| `WORKER_URL` | バックエンドの公開 HTTPS URL。例: `https://line.example.com` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | オブジェクトストレージ認証情報。`minioadmin` のデフォルトから必ず変更。MinIO の root ユーザー/パスワードにもなります。 |

主なオプション:

| 変数 | 内容 |
|---|---|
| `ADMIN_ORIGIN` | 管理画面オリジンの許可リスト（カンマ区切り・末尾スラッシュなし）。例: `https://your-admin.vercel.app`。管理画面を別ドメイン（Vercel/Pages）でホストする場合に必要。 |
| `ADMIN_ALLOW_CROSS_SITE` | 管理画面と API が別サイトの場合（Vercel ↔ VPS）は `true` — `SameSite=None; Secure` のセッション Cookie を発行。 |
| `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` | LINE Login チャネル。LIFF フォーム/認証で使用。 |
| `LIFF_URL` | LIFF アプリ URL（`https://liff.line.me/<liff-id>`）。 |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_FORCE_PATH_STYLE` | ストレージの場所。デフォルトは同梱 MinIO。AWS S3 / R2 に向けることも可能。 |
| `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PORT` / `DATABASE_URL` | DB 接続情報。`.env` の `DATABASE_URL` はホスト上でバックエンドを直接動かす場合のみ使用され、docker-compose 内では `postgres` サービス向けに上書きされます。 |
| `BACKEND_PORT` | バックエンドを公開するホストポート（コンテナ内は 8787）。 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI 互換のチャット自動返信。ここで設定した値は管理 UI のグローバル設定を変数単位で上書き。 |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 連携を使う場合のみ。 |
| `X_HARNESS_URL` | 他 Harness とのアカウント連携（任意）。 |

### アップデート

```bash
git pull
docker compose up -d --build   # マイグレーションは起動時に自動適用
```

### バックアップ

状態を持つのは named volume の `pgdata` と `minio-data` だけです。両方セットでバックアップしてください:

```bash
docker compose exec postgres pg_dump -U postgres linecrm | gzip > backup.sql.gz
# 加えて minio-data ボリュームのコピー / rclone 同期
```

---

## フロントエンド (管理画面): Vercel でデプロイ

管理画面は Next.js の静的エクスポートなので、サーバー設定なしで Vercel にデプロイできます。詳細: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)（Method 4）。

1. **Vercel プロジェクトを作成** — ダッシュボード → *Add New → Project* でこのリポジトリをインポートし、以下を設定:
   - **Root Directory**: `apps/web`（"Include source files outside of the Root Directory" は有効のまま — ビルドに workspace パッケージが必要）
   - **Framework Preset**: Next.js（自動検出）
2. **Vercel ダッシュボードで環境変数を設定**（*Project → Settings → Environment Variables*）:

   | 変数 | 値 |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | バックエンドの公開 HTTPS URL。例: `https://line.example.com` — 末尾スラッシュなし |

   フロントエンドに必要な環境変数は **これ 1 つだけ** です。
3. **バックエンド側で Vercel オリジンを許可** — バックエンドの `.env` に:

   ```bash
   ADMIN_ORIGIN=https://your-admin.vercel.app
   ADMIN_ALLOW_CROSS_SITE=true
   ```

   を設定して `docker compose up -d` で再起動。
4. **デプロイ。** 以後は production ブランチへの push ごとに Vercel が自動ビルドします。

---

## 代替: Cloudflare ワンコマンドセットアップ

従来の Cloudflare 構成（Workers + D1 + R2 + Pages、無料枠）も引き続き利用できます:

```bash
npx create-line-harness
```

CLI が Cloudflare 認証、D1 作成 + マイグレーション、Worker / 管理画面デプロイ、LINE credentials 登録、LIFF アプリ作成、初回 Owner ユーザー作成まで自動実行（約 5 分）。詳細: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## 主要機能

### 配信
- **ステップ配信** — `delay_minutes` で分単位制御、条件分岐、ステルス送信
- **ブロードキャスト** — 全員 / タグ / セグメント、即時 or 予約、500 人超は自動キュー化
- **リマインダー** — 指定日時からのカウントダウン配信（3 日前 / 1 日前 / 当日）
- **テンプレート** — `{{name}}` `{{uid}}` `{{auth_url:CHANNEL_ID}}` でパーソナライズ
- **トラッキングリンク** — クリック計測 → 自動タグ付け → シナリオ起動

### CRM
- **友だち管理** — Webhook 自動登録、プロフィール取得、カスタムメタデータ
- **タグ & スコアリング** — 配信条件・シナリオトリガー、行動ベースのリードスコア
- **オペレーターチャット & Conversation Inbox** — 管理画面から 1:1 返信、未返信会話を放置時間順で一覧
- **重複検出** — `picture_url` トークン照合で複数アカウント間の同一ユーザーを自動タグ付け

### マーケティング
- **リッチメニュー** — ユーザー別 / タグ別の自動切替
- **フォーム (LIFF)** — LINE 内完結フォーム、回答 → メタデータ自動保存
- **カレンダー予約** — Google Calendar 連携の予約システム (LIFF)
- **スタッフ管理** — Owner / Admin / Staff の 3 ロール、API key 個別発行

### アフィリエイト計測（ASP）
- LIFF からのワンタップリンク発行、案件別固定報酬、クリック → 友だち追加 → CV の時系列トラッキング（last-touch 帰属）、成果承認フロー、確定時の LINE push 通知。詳細: [docs/wiki/27-Affiliate-ASP.md](docs/wiki/27-Affiliate-ASP.md)

### 自動化
- **IF-THEN ルール** — 7 種のトリガー × 6 種のアクション
- **自動返信** — キーワード完全一致 / 部分一致
- **Webhook IN/OUT** — Stripe / Slack 等の外部サービス連携
- **通知ルール** — 条件付きアラート配信

### マルチアカウント
- 複数 LINE 公式アカウントを 1 ダッシュボードで管理、アカウント別シナリオ・タグ・配信、**BAN 検知** → 次アカウントへ自動友だち移行、トラフィックプール

### AI 統合
- **MCP Server 同梱** (`@line-harness/mcp-server`) — Claude Code から自然言語で全操作
- **型付き SDK** (`@line-harness/sdk`) — TypeScript、ESM + CJS、ゼロ依存

---

## ドキュメント

- [Docker セルフホストガイド](docs/DOCKER.md) ・ [PostgreSQL ガイド](docs/POSTGRES.md) ・ [デプロイガイド](docs/DEPLOYMENT.md)
- [Wiki](docs/wiki/Home.md) — 機能別マニュアル、API / SDK リファレンス
- npm: [@line-harness/sdk](https://www.npmjs.com/package/@line-harness/sdk) ・ [@line-harness/mcp-server](https://www.npmjs.com/package/@line-harness/mcp-server) ・ [create-line-harness](https://www.npmjs.com/package/create-line-harness)

---

## ライセンス

MIT License。商用利用・改変・再配布自由。

## コントリビュート

Issue / PR 歓迎 — [CONTRIBUTING.md](CONTRIBUTING.md) 参照。

## 開発者 / Author

**野田修一（Shudesu）** — Harness シリーズ（LINE Harness / IG Harness / X Harness）開発者、AIエージェント株式会社 代表

- GitHub: [@Shudesu](https://github.com/Shudesu) ・ X: [@ai_shunoda](https://x.com/ai_shunoda)
- 公式ドキュメント: [Harness Wiki](https://harness-wiki.pages.dev) ・ 商用ツール比較: [The Harness Lab](https://the-harness.com)

> **LINE Harness** — AI ネイティブ時代の OSS LINE CRM
