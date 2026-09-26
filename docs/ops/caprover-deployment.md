# Deploying Suffa on CapRover (same pattern as Tabayyun)

Suffa is deployed exactly like Tabayyun (`thedatadudech/Tabayyun`, `deploy/caprover.md`):
images are built by GitHub Actions, published to GHCR, and deployed to CapRover apps with
app tokens. CapRover's nginx terminates TLS; the web app's Caddy serves the PWA and proxies
`/api` and `/media` over the internal network. Jobs run in a worker from the api image with a
Postgres queue (no Redis, ADR-0020). Files go to the **existing `rustfs` app** (ADR-0017).

```
Internet ─▶ CapRover nginx (TLS) ─▶ suffa-web (Caddy :80) ─/api───▶ suffa-api (:8000) ─┐
                                              │                                        ├─▶ suffa-db (Postgres 17 + pgvector)
                                              └─/media─▶ rustfs (:9000, shared)        │
                                                             ▲                         │
                                                  suffa-worker (api image, ROLE=worker)┘
```

> **Status:** `suffa-web` serves the full offline app; `suffa-api` is a skeleton (health,
> migrations, worker heartbeat) that grows sprint by sprint (`docs/plan/sprint-plan.md`).

## Two servers: staging and tools, production (ADR-0024)

Suffa runs on **two independent CapRover servers** (Sīra family decision, Arqam ADR-0020):

| Server                               | Runs                                                                                                     | Data                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Staging and tools** (current host) | `suffa-web`, `suffa-api`, `suffa-worker`, `suffa-db`, `suffa-backup` (today's apps), `rustfs`, GlitchTip | test accounts and generated data only           |
| **Production** (new, Germany)        | `suffa-web`, `suffa-api`, `suffa-worker`, `suffa-db`, `suffa-backup`, WAL-G, its **own** `rustfs`        | real learners; the only place for personal data |

- **Every push to `main`** is deployed to the staging apps and checked there (`/healthz` and
  `/healthz-web` report the new `sha-…`).
- **Production** gets the **same image digests** after the owner approves the run in the GitHub
  environment `production` (§6). Nothing is rebuilt.
- **`srv-captain--*` names only resolve inside one CapRover.** Each server has its own
  `rustfs` app with the same name, so `SUFFA_S3_ENDPOINT=http://srv-captain--rustfs:9000` is
  the same on both.
- **GlitchTip stays on the staging and tools server.** Production reaches it through its
  public HTTPS address (§9.2).
- **Production has its own everything:** `SUFFA_AUTH_SECRET`, VAPID and FCM keys, Google OAuth
  client, RustFS keys, SMTP settings and CapRover app tokens. None is shared with staging.
  Keep `SUFFA_AUTH_SECRET` in the owner's password manager too. It signs sessions and seals
  the stored Drive tokens and admin 2FA secrets.
- **Restore drills** run on the production server into a throwaway database (§8.3), never on
  staging.
- **Nothing is copied across.** The owner, family and friends sign up again on production once
  it is live. Their accounts on staging are then deleted (§8.5).
- **Both servers:** SSH by key only; firewall opens 80, 443 and 22 only; CapRover dashboard
  with a strong password and 2FA; unattended security updates.

The sections below describe one server; both servers use the same app names, since each
CapRover has its own name space. Staging and production differ only in their secrets and
domains.

### Today's apps are staging

Nothing is renamed or moved. The apps on the current server (`suffa-web`, `suffa-api`, … without
suffix) are staging as they are, with the repository's `CAPROVER_SERVER` and
`CAPROVER_APP_TOKEN_*`. The release binds them to the GitHub environment **`staging`**; values set
in that environment win over the repository's. Its URL defaults to
`https://suffa.siralabs.org`. When that domain moves to production (§8.5), give staging its own
domain and set `SUFFA_STAGING_URL` (repository or environment `staging`).

## Quick start: one-click templates (YAML)

The templates live in `infra/caprover/one-click/`. In CapRover: **Apps → One-Click
Apps/Databases → `>> TEMPLATE <<`**, paste the file, enter the app name (**`suffa`**, or
**`glitchtip`** for the error tracker), deploy.

| Template           | Creates                                              | Use when                                                                     |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `suffa.yml`        | `suffa-web`, `suffa-db`                              | Just the offline app + database                                              |
| `suffa-full.yml`   | `suffa-db`, `suffa-api`, `suffa-worker`, `suffa-web` | **Recommended** — full stack (health, migrations, sync endpoints, job queue) |
| `suffa-backup.yml` | `suffa-backup`                                       | Nightly verified backups into RustFS (§8)                                    |
| `glitchtip.yml`    | `glitchtip`, `glitchtip-db`                          | Error tracking and uptime checks (§9)                                        |

The images are built by `.github/workflows/release.yml` on every push to `main` and
published **publicly** on GHCR (`ghcr.io/sira-labs/suffa-web`, `suffa-api`), so CapRover
needs no registry credentials. If a pull ever fails with `unauthorized`, open the package on
GitHub (Packages → suffa-web / suffa-api / suffa-backup → Package settings) and set its
visibility to public. In a GitHub organization new packages start **private**: after the
first release there, make all three public once.
For deploying without GHCR, the root `captain-definition` builds the same image on the server
(method 3 in Tabayyun's guide).

## What to create

| #   | CapRover app          | Image                                          | Persistent data                                   | Public domain                   | Notes                                                                                |
| --- | --------------------- | ---------------------------------------------- | ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `suffa-db`            | `pgvector/pgvector:<pinned>-pg17`              | `/var/lib/postgresql/data` (label `suffa-pgdata`) | no                              | Plain app, not a one-click DB (needs pgvector). No host port.                        |
| 2   | `suffa-api`           | `ghcr.io/sira-labs/suffa-api:<sha>`            | none                                              | optional                        | Runs DB migrations on start; refuses to start on placeholder secrets. Port **8000**. |
| 3   | `suffa-worker`        | same image as api                              | `/data/tmp` (scratch for transcodes)              | no                              | `SUFFA_ROLE=worker`. Has `ffmpeg`. Exits with code 3 until the api has migrated.     |
| 4   | `suffa-web`           | `ghcr.io/sira-labs/suffa-web:<sha>`            | none                                              | **yes** (e.g. `suffa.<domain>`) | Caddy + PWA; proxies `/api`, `/healthz`, `/media`. Port **80**.                      |
| —   | `rustfs` (**exists**) | `rustfs/rustfs:1.0.0` (as pinned for Tabayyun) | existing                                          | no                              | Add buckets + a Suffa-only key (below).                                              |

Separate `suffa-db` rather than a second database inside `tabayyun-db`: the two apps then
upgrade, restart and restore independently.

## 1. `suffa-db`

- _Deploy via ImageName_: `pgvector/pgvector:<pinned tag>-pg17` (pin exactly; upgrade deliberately).
- Env: `POSTGRES_USER=suffa`, `POSTGRES_PASSWORD=<openssl rand -hex 24>`, `POSTGRES_DB=suffa`.
- Persistent directory `/var/lib/postgresql/data`, label `suffa-pgdata`. No port mapping.
- The API reaches it at `srv-captain--suffa-db:5432`.

## 2. RustFS: buckets and key (existing `rustfs` app)

In the RustFS console (open port 9001 temporarily or via SSH tunnel, as for Tabayyun):

1. Create buckets `suffa-media`, `suffa-uploads`, `suffa-content`.
2. Create access key `suffa-app` with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::suffa-media/*",
        "arn:aws:s3:::suffa-uploads/*",
        "arn:aws:s3:::suffa-content/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": [
        "arn:aws:s3:::suffa-media",
        "arn:aws:s3:::suffa-uploads",
        "arn:aws:s3:::suffa-content"
      ]
    }
  ]
}
```

## 3. `suffa-api`

Env (App Configs → Environment variables):

| Name                                                                        | Value                                                                                                               | From sprint |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------- |
| `SUFFA_ENV`                                                                 | `prod`                                                                                                              | S1          |
| `SUFFA_PUBLIC_URL`                                                          | `https://suffa.<domain>`                                                                                            | S1          |
| `SUFFA_DATABASE_URL`                                                        | `postgres://suffa:<password>@srv-captain--suffa-db:5432/suffa`                                                      | S1          |
| `SUFFA_AUTH_SECRET`                                                         | `openssl rand -base64 48`                                                                                           | S3          |
| `SUFFA_ERROR_DSN`                                                           | DSN of the GlitchTip project `suffa-api` (§9); unset = no error reporting                                           | S2          |
| `SUFFA_WEB_ERROR_DSN`                                                       | DSN of the GlitchTip project `suffa-web` (§9), handed to the PWA via `/api/client-config`                           | S2          |
| `SUFFA_SYNC_DEV_TOKENS`                                                     | **never in prod** (the api refuses to start): `token=userUuid;…` for local/test sync before Better Auth             | dev only    |
| `SUFFA_SMTP_HOST`, `SUFFA_SMTP_PORT`                                        | `smtp-relay.gmail.com`, `587` – Google Workspace SMTP relay (§ Sign-in mails)                                       | S3          |
| `SUFFA_SMTP_USER`, `SUFFA_SMTP_PASSWORD`                                    | optional, only if the relay requires SMTP authentication (Workspace user + app password)                            | S3          |
| `SUFFA_TRUSTED_ORIGINS`                                                     | optional: further addresses the app is served from (e.g. the old domain), comma-separated                           | S5          |
| `SUFFA_VAPID_PUBLIC_KEY`, `SUFFA_VAPID_PRIVATE_KEY`                         | `npx web-push generate-vapid-keys` (once; keep them, new keys cancel every device's reminders)                      | S6          |
| `SUFFA_VAPID_SUBJECT`                                                       | `mailto:<ops address>` – contact for push services; reminders stay off until all three are set                      | S6          |
| `SUFFA_TRANSCRIBE_URL`                                                      | optional: `https://api.mistral.ai/v1/audio/transcriptions` (Mistral Voxtral, EU, §11)                               | S8          |
| `SUFFA_TRANSCRIBE_TOKEN`, `SUFFA_TRANSCRIBE_MODEL`                          | model, default `voxtral-mini-latest`; the token falls back to `SUFFA_MISTRAL_API_KEY` for Mistral                   | S8          |
| `SUFFA_TRANSCRIBE_LANGUAGE`                                                 | optional: `ar` to force Arabic; empty = detect per piece (mixed German/Arabic lessons)                              | S8          |
| `SUFFA_APP_ORIGINS`                                                         | native app web view origins for bearer-token API access; default `capacitor://localhost,https://localhost`          | S13         |
| `SUFFA_IOS_APP_IDS`                                                         | optional: `TEAMID.org.siralabs.suffa` for Universal Links (`/.well-known/apple-app-site-association`)               | S13         |
| `SUFFA_ANDROID_APP_LINKS`                                                   | optional: `org.siralabs.suffa:<SHA-256 of the signing key>` for App Links (`/.well-known/assetlinks.json`)          | S13         |
| `SUFFA_FCM_SERVICE_ACCOUNT`                                                 | optional: Firebase service account JSON, base64; push to the native apps (worker)                                   | S13         |
| `SUFFA_YOUTUBE_API_KEY`                                                     | optional: YouTube Data API v3 key (restrict it to the server IP) for the video catalog import; worker               | S12         |
| `SUFFA_ANTHROPIC_API_KEY`                                                   | optional: turns on Anthropic routes (AI gateway, ADR-0010); api and worker                                          | S9          |
| `SUFFA_OPENROUTER_API_KEY`                                                  | optional: turns on OpenRouter routes (open-weight models)                                                           | S9          |
| `SUFFA_HF_API_KEY`, `SUFFA_HF_ENDPOINT_URL`                                 | optional: Hugging Face token; endpoint URL for a dedicated Inference Endpoint (router otherwise)                    | S9          |
| `SUFFA_MISTRAL_API_KEY`                                                     | optional: Mistral (EU); recording summaries/suggestions, and Voxtral transcripts (§11)                              | S15         |
| GitHub secret `SUFFA_EVAL_ANTHROPIC_API_KEY`                                | optional, CI only: runs the AI evals (`.github/workflows/evals.yml`, ≤ $0.30 per run); use a key with a spend limit | S11         |
| `SUFFA_GOOGLE_CLIENT_ID`, `SUFFA_GOOGLE_CLIENT_SECRET`                      | OAuth web client (Google Cloud), redirect URI `https://<app>/api/v1/drive/callback`, scope `drive.file`             | S7          |
| `SUFFA_GOOGLE_API_KEY`, `SUFFA_GOOGLE_APP_ID`                               | browser API key (Picker API, restricted to the app's domain) and the project number                                 | S7          |
| `SUFFA_ENCRYPTION_KEY`                                                      | `openssl rand -base64 32` (encrypts Google refresh tokens)                                                          | S7          |
| `SUFFA_MAIL_FROM`                                                           | `Suffa <noreply@<domain>>` – any address of the Workspace domain                                                    | S3          |
| `SUFFA_S3_ENDPOINT`                                                         | `http://srv-captain--rustfs:9000`                                                                                   | S7          |
| `SUFFA_S3_ALLOW_HTTP`                                                       | `true` (internal endpoint only)                                                                                     | S7          |
| `SUFFA_S3_ACCESS_KEY_ID` / `SUFFA_S3_SECRET_ACCESS_KEY`                     | the `suffa-app` key                                                                                                 | S7          |
| `SUFFA_S3_BUCKET_MEDIA` / `_UPLOADS` / `_CONTENT`                           | `suffa-media` / `suffa-uploads` / `suffa-content`                                                                   | S7          |
| `SUFFA_MEDIA_PUBLIC_PREFIX`                                                 | `/media` (presigned URLs are rewritten to this same-origin path)                                                    | S7          |
| `SUFFA_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` / `_SUBJECT`                      | `npx web-push generate-vapid-keys`; subject `mailto:you@<domain>`                                                   | S6          |
| `SUFFA_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` / `SUFFA_GOOGLE_PICKER_API_KEY` | Google Cloud project (Drive API + Picker)                                                                           | S7          |
| `SUFFA_YOUTUBE_API_KEY`                                                     | Google Cloud project (YouTube Data API v3)                                                                          | S12         |
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`                       | provider keys                                                                                                       | S9          |
| `SUFFA_FCM_SERVICE_ACCOUNT`                                                 | Firebase service-account JSON (base64)                                                                              | S13         |

- Container HTTP port `8000`. HTTP settings: no public domain needed.
- Deployment tab → **Enable App Token** → GitHub secret `CAPROVER_APP_TOKEN_API`.

## 4. `suffa-worker`

- Same image and **same env** as `suffa-api`, plus `SUFFA_ROLE=worker`,
  `SUFFA_WORKER_CONCURRENCY=2`, `SUFFA_TRANSCODE_CONCURRENCY=1` (protects Tabayyun's CPU).
- Persistent directory `/data/tmp` (transcode scratch; cleaned by the worker).
- No HTTP settings. App token → `CAPROVER_APP_TOKEN_WORKER` (deploy step skipped until set).

## 5. `suffa-web`

- Env: `SUFFA_API_UPSTREAM=srv-captain--suffa-api:8000`,
  `SUFFA_MEDIA_UPSTREAM=srv-captain--rustfs:9000`.
- Container HTTP port `80`. Connect domain, **Enable HTTPS**, **Force HTTPS**.
- App token → `CAPROVER_APP_TOKEN_WEB`.

Caddyfile sketch (lives in `infra/caddy/Caddyfile`, mirrors Tabayyun's):

```caddy
:80 {
	encode zstd gzip
	header {
		Content-Security-Policy "default-src 'self'; script-src 'self' https://www.youtube.com https://apis.google.com; frame-src https://www.youtube-nocookie.com https://docs.google.com; img-src 'self' data: https://i.ytimg.com; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(self), geolocation=()"
		-Server
	}
	@api path /api/* /healthz
	handle @api {
		reverse_proxy {$SUFFA_API_UPSTREAM}
	}
	# Presigned S3 URLs, signed by the API for the internal host; RustFS itself stays private.
	@media {
		path /media/*
		method GET HEAD PUT
	}
	handle @media {
		uri strip_prefix /media
		reverse_proxy {$SUFFA_MEDIA_UPSTREAM} {
			header_up Host {$SUFFA_MEDIA_UPSTREAM}
		}
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

Uploads use multipart parts ≤ 64 MB. If you still see `413` from CapRover's nginx, raise
`client_max_body_size` in the `suffa-web` app's nginx config (HTTP Settings → Edit default
nginx configurations).

## 6. GitHub Actions: staging, then production

`.github/workflows/release.yml` runs on every push to `main`:

1. **checks, images:**
   - runs CI;
   - builds `suffa-api`, `suffa-web` and `suffa-backup`;
   - smoke-tests and scans each image;
   - pushes **exactly that image** as `sha-<short>`.
2. **deploy-staging:** resolves the tags to digests and deploys them to the staging apps (api
   first, it migrates; then worker, backup, web). All four apps or none: a partly configured
   staging fails the run, so production is only offered a release staging ran in full.
3. **verify-staging:** waits until staging's `/healthz` and `/healthz-web` report the new
   `sha-…`.
4. **deploy-production:** waits for the owner's approval, then deploys the **same digests** to
   production and checks its `/healthz` and `/healthz-web` the same way.
   - The job refuses to run in these cases:
     - the environment has no required reviewer;
     - production is only partly configured, or `SUFFA_PRODUCTION_URL` is missing;
     - its server is the staging server;
     - staging no longer runs this release. A newer push replaced it while the run waited for
       approval; approve the newest run instead.
   - Before production exists, it only leaves a notice.

**Staging:** the repository settings as they are, or the same names in the environment
`staging` (Settings → Environments → `staging`, no reviewer needed). Environment values win.

| Kind     | Name                                                      | Value                                                                         |
| -------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| variable | `CAPROVER_SERVER`                                         | `https://captain.<staging root domain>`                                       |
| secret   | `CAPROVER_APP_TOKEN_API` / `_WORKER` / `_WEB` / `_BACKUP` | app tokens of the staging apps (all four, or none to skip staging)            |
| variable | `SUFFA_STAGING_URL`                                       | optional; default `https://suffa.siralabs.org` until that domain moves (§8.5) |
| variable | `CAPROVER_APP_API` / `_WORKER` / `_WEB` / `_BACKUP`       | optional; default `suffa-api` / `suffa-worker` / `suffa-web` / `suffa-backup` |

**Environment `production`** (Settings → Environments → New environment → `production`):

- **Required reviewers:** the owner. Optionally allow only the `main` branch (Deployment
  branches and tags → Selected → `main`).
- These are environment variables and secrets, **not** repository ones: only the production
  job can read them. Their `_PROD` names never match a staging value.

| Kind     | Name                                                                          | Value                                             |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| variable | `CAPROVER_SERVER_PROD`                                                        | `https://captain.<production root domain>`        |
| variable | `SUFFA_PRODUCTION_URL`                                                        | `https://suffa.siralabs.org` once it points there |
| variable | `CAPROVER_APP_API_PROD` / `_WORKER_PROD` / `_WEB_PROD` / `_BACKUP_PROD`       | only to override `suffa-api` / … (defaults)       |
| secret   | `CAPROVER_APP_TOKEN_API_PROD` / `_WORKER_PROD` / `_WEB_PROD` / `_BACKUP_PROD` | app tokens of the production apps (all four)      |

**Image pulls on the production server:** CapRover pulls the images itself, and the workflow's
GHCR login does not reach it. Keep the packages `suffa-web`, `suffa-api` and `suffa-backup`
**public**, as on staging. If they are private, add the registry on the production CapRover
(Cluster → Docker Registry Configuration → Add Remote Registry: `ghcr.io`, a GitHub user, and a
token with only `read:packages`). Before the first promotion, deploy one digest by hand on the
production server (Deploy via ImageName, `ghcr.io/sira-labs/suffa-web@sha256:…`) to see the
pull work.

To promote: open the run in Actions → **Review deployments** → `production` → Approve. Only the
newest waiting run deploys; an older one still waiting is replaced. **Rolling back:** Actions →
**rollback production** → Run workflow (from `main`) → tag of the release to go back to
(`sha-…`, as `/healthz` reported it). It resolves that tag's images to digests and deploys them
through the same approval and checks, except that staging need not run that tag. Schema
migrations only go forward, so check the migrations between the two releases
(`apps/api/migrations/`) before rolling back across one.

## 7. Order of setup (first time)

1. `suffa-db` → 2. RustFS buckets + key → 3. `suffa-api` (first deploy by ImageName; watch log
   for `migrate.done`) → 4. `suffa-worker` → 5. `suffa-web` + domain + HTTPS → 6. GitHub
   variables/secrets → 7. push to `main` and confirm the three deploy steps.
2. Open `https://suffa.<domain>/healthz-web` → `{ "status": "ok", "role": "web", "version": "sha-…" }` (the web image), and `https://suffa.<domain>/healthz` → `{ "status": "ok", "db": "ok", "schemaRevision": "0002_users_and_sync_tables", "queue": { "waiting": 0, "active": 0, "failed": 0, "deadLetter": 0 } }`. A growing `waiting` count means the worker is down; `deadLetter` counts jobs that failed all retries. `/api/version` shows the deployed image tag.

## 8. Backups (`suffa-backup`)

Every night a small app takes a `pg_dump` of `suffa-db`, checks that it can be read back
(`pg_restore --list`), uploads it to the RustFS bucket `suffa` and checks the uploaded size.
Image: `ghcr.io/sira-labs/suffa-backup` (scripts in `infra/backup/`).

```
suffa/postgres/daily/YYYY/MM/suffa-<timestamp>.dump     every night
suffa/postgres/monthly/YYYY/suffa-<timestamp>.dump      additionally on the 1st
```

### 8.1 RustFS: bucket and write-only key

1. Bucket `suffa` with **versioning** and **object lock** (done).
2. Default retention (bucket → Object Lock): **Governance, 35 days** is a good start. Compliance
   mode is stricter (nobody can shorten it, not even the root user) but also cannot be undone.
3. If your RustFS version supports lifecycle rules: expire `postgres/daily/` after 35 days and
   `postgres/monthly/` after 400 days, and noncurrent versions after 35 days. Until then the
   bucket simply grows (a Suffa dump is small: kilobytes to a few MB).
4. Access key **`suffa-backup`** with this policy — it can write and read (for restores) but
   **cannot delete**, so a compromised server cannot wipe the backups:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": ["arn:aws:s3:::suffa/postgres/*"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": ["arn:aws:s3:::suffa"]
    }
  ]
}
```

### 8.2 Deploy

1. CapRover → One-Click Apps → `>> TEMPLATE <<` → paste
   `infra/caprover/one-click/suffa-backup.yml` → app name **`suffa`** → fill in the suffa-db
   password and the key's secret → Deploy. This creates the app `suffa-backup`.
2. `suffa-backup` → App Logs: within a minute `backup.done` with size, table count and SHA-256,
   then `backup.scheduled` with the next run (default 02:30 UTC).
3. Optional alerting: create an Uptime Kuma **push** monitor (interval 25 h) and put its URL
   into `SUFFA_BACKUP_PING_URL`; a missing or failed backup then raises an alert.
4. Automatic updates: Deployment → Enable App Token → GitHub secret `CAPROVER_APP_TOKEN_BACKUP`.

| Variable                                               | Default                      | Meaning                                                  |
| ------------------------------------------------------ | ---------------------------- | -------------------------------------------------------- |
| `SUFFA_BACKUP_DATABASE_URL`                            | —                            | `postgres://suffa:<pw>@srv-captain--suffa-db:5432/suffa` |
| `SUFFA_BACKUP_S3_ENDPOINT` / `_BUCKET`                 | —                            | `http://srv-captain--rustfs:9000` / `suffa`              |
| `SUFFA_BACKUP_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | —                            | the `suffa-backup` key                                   |
| `SUFFA_BACKUP_S3_REGION`, `_PROVIDER`, `_PATH_STYLE`   | `us-east-1`, `Other`, `true` | for other S3 providers                                   |
| `SUFFA_BACKUP_PREFIX`                                  | `postgres`                   | folder inside the bucket                                 |
| `SUFFA_BACKUP_TIME_UTC`                                | `02:30`                      | daily run time                                           |
| `SUFFA_BACKUP_RUN_ON_START`                            | `false` (template: `true`)   | back up right after each start                           |
| `SUFFA_BACKUP_PING_URL`                                | —                            | monitoring push URL                                      |

Uploads carry `Content-MD5` on every request/part (required by object-lock buckets) and use
only PUT/GET/HEAD/list calls — verified against RustFS with object lock.

### 8.3 Restore drill (monthly, on the production server)

Restore production backups **on the production server** into a throwaway database, check it,
note how long it took, and drop it. **Never into staging**: that would copy real learners' data
there (ADR-0024). Never restore into the live database either; the script refuses when the
target equals `SUFFA_BACKUP_DATABASE_URL`. Record date, backup, duration and row counts in the
drill log (`docs/ops/restore-drills.md`).

```bash
# 1. scratch database
docker exec -it $(docker ps -q -f name=srv-captain--suffa-db) \
  psql -U suffa -c 'create database restore_drill'
# 2. restore the newest daily backup into it
docker exec -it $(docker ps -q -f name=srv-captain--suffa-backup) sh -c \
  'SUFFA_RESTORE_DATABASE_URL=${SUFFA_BACKUP_DATABASE_URL%/suffa}/restore_drill /opt/suffa-backup/restore.sh latest'
# 3. check, then drop the scratch database
docker exec -it $(docker ps -q -f name=srv-captain--suffa-db) \
  psql -U suffa -d restore_drill -c 'select count(*) from users; select count(*) from srs_cards'
docker exec -it $(docker ps -q -f name=srv-captain--suffa-db) psql -U suffa -c 'drop database restore_drill'
```

A specific backup: `restore.sh postgres/daily/2026/09/suffa-20260923T023000Z.dump`.

Every second drill also restores the **physical backup to a point in time** (§8.4): WAL-G
fetches the newest base backup into an empty data directory of a throwaway `suffa-db-drill`
app, replays WAL up to a chosen minute, and the same row-count check runs against it.

### 8.4 Production: point-in-time recovery and an off-site copy (story 2.8)

On the production server, `suffa-backup` is one of three layers. All of them are **encrypted
before upload** and go to S3-compatible object storage in **another Hetzner location** than the
production server. The server's own RustFS is not a backup of the server.

| Layer                    | What                                                                                                                            | Restores to                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Continuous WAL archiving | WAL-G `archive_command` in `suffa-db`; every finished WAL segment, plus `archive_timeout = 60s` so a quiet database still ships | any minute since the oldest full |
| Physical base backups    | WAL-G `backup-push`: weekly full, daily delta; **at least two fulls kept**                                                      | the base WAL replays onto        |
| Nightly `pg_dump -Fc`    | `suffa-backup` as today, uploaded off-site as well                                                                              | a portable copy, any Postgres 17 |

- **Why both WAL and base backups:** WAL replays only onto a base backup. The RPO of minutes
  rests on the base backups, not only on WAL.
- **Encryption:** WAL-G uses libsodium (`WALG_LIBSODIUM_KEY`); the dump is encrypted before
  upload. Keep the keys in the owner's password manager, **not only on the server**. Without
  them the backups are unreadable.
- **Object storage key:** as in §8.1, it can write and read but not delete, plus object lock on
  the bucket.
- **Staging:** keeps only the nightly dump (test data). Nothing on staging is archived
  off-site.
- **Recordings** in `suffa-media` join the off-site copy with versioning, so deleted objects
  stay recoverable.
- **Standby database** in a second location, failover rehearsed: planned before any paid
  launch (restore takes hours; promoting a standby takes minutes).

### 8.5 When production goes live

1. Production apps deployed through the approved release; `suffa.siralabs.org` points at the
   production server; staging gets its own domain (`suffa-stg.<domain>`), set as
   `SUFFA_STAGING_URL`.
2. The owner, family and friends sign up again on production. Nothing is copied from staging.
3. On staging, delete their accounts: each person with **Einstellungen → Konto löschen**
   (story 4.4), or the admin with `delete from users where email in (…)`. Sessions, devices,
   learning records and memberships go with the user (`on delete cascade`). Rows others still
   need, such as classes they created, keep only a cleared author (`on delete set null`);
   delete those test classes too. Record the clean-up in `docs/ops/restore-drills.md`.
4. From then on staging holds test accounts only.

## 9. Error tracking and uptime (GlitchTip)

GlitchTip is Sentry-compatible and runs on the **staging and tools server** (ADR-0024): one
container (web + background worker) plus its own Postgres, **no Redis**. It serves both
servers. Production apps cannot reach `srv-captain--glitchtip`, so their DSNs use GlitchTip's
**public HTTPS address**. Keep GlitchTip's public domain (and HTTPS) until a Hetzner private
network between the two servers replaces it. Suffa sends errors only, never personal data:
no user info, cookies, headers, query strings or request bodies, and no session pings.

```
browser ──/api/errors──▶ suffa-api (tunnel: checks DSN, 256 KB cap, rate limit) ──▶ GlitchTip
suffa-api / suffa-worker ─────────────────────────────────────────────────────────▶ GlitchTip
```

The browser never talks to GlitchTip directly: ad blockers cannot drop the reports, the CSP
stays `connect-src 'self'`, and GlitchTip does not see learners' IP addresses.

### 9.1 Deploy GlitchTip

1. One-click → `>> TEMPLATE <<` → paste [`infra/caprover/one-click/glitchtip.yml`](../../infra/caprover/one-click/glitchtip.yml)
   → app name **`glitchtip`** → Deploy (creates `glitchtip` and `glitchtip-db`).
2. `glitchtip` → HTTP Settings → **Enable HTTPS** (and Force HTTPS).
3. Open `https://glitchtip.<root domain>` and **register right away**: registration is closed,
   only the very first account is allowed. Create the organization **Suffa**.
4. Check the app log: it must not mention `redis:6379`. If it does, CapRover dropped the empty
   variable: add `VALKEY_URL` with an empty value under App Configs and **Save & Update**.

### 9.2 Connect Suffa

1. In GlitchTip create two projects: **`suffa-api`** (platform Node.js) and **`suffa-web`**
   (platform Browser JavaScript). Each shows its DSN under Settings → Client Keys.
2. `suffa-api` → env: `SUFFA_ERROR_DSN=<DSN suffa-api>` and `SUFFA_WEB_ERROR_DSN=<DSN suffa-web>`.
3. `suffa-worker` → env: `SUFFA_ERROR_DSN=<DSN suffa-api>` (the `role` tag tells api and
   worker apart).
4. **Save & Update** both apps. The start log shows `"errorTracking":true`.
5. The DSN is always the **public** one (`https://<key>@glitchtip.<root domain>/<id>`) on
   both servers, never `srv-captain--glitchtip`. Both servers run `SUFFA_ENV=prod` (staging
   gets the same hardening), so staging reports to its own projects, **`suffa-api-stg`** and
   **`suffa-web-stg`**, and production to `suffa-api` and `suffa-web`.

### 9.3 Verify (acceptance of story 2.4)

```bash
# a test error from the server, tagged with the deployed release (sha-…)
docker exec $(docker ps -q -f name=srv-captain--suffa-api) node dist/error-test.js
```

In GlitchTip → suffa-api: _"Suffa error tracking test (sha-…)"_ with release `sha-…`,
environment `prod` and tag `role: api`. For the browser, open the app, then in the browser
console run `setTimeout(() => { throw new Error('browser test') })`; it appears in
suffa-web with the same release.

### 9.4 Uptime checks and alerts

GlitchTip → Uptime Monitors → **New**:

| Name        | URL                                               | Interval | Expect |
| ----------- | ------------------------------------------------- | -------- | ------ |
| Suffa       | `https://suffa.siralabs.org/healthz` (production) | 60 s     | 200    |
| Suffa (PWA) | `https://suffa.siralabs.org/healthz-web`          | 5 min    | 200    |
| Suffa stg   | `https://suffa-stg.<domain>/healthz`              | 5 min    | 200    |

`/healthz` answers 503 when the database is unreachable, the schema is behind or the job queue
is missing, so one monitor covers api, database and queue. Alerts: Project → Alerts → e-mail
(needs a real `EMAIL_URL`, e.g. `smtp+tls://user:password@smtp.example.com:587`) or a webhook
(Discord, Slack, ntfy …). Retention: 90 days by default (`GLITCHTIP_RETENTION_DAYS`).

GlitchTip's own database is **not** covered by `suffa-backup`; losing it only loses the error
history. Back it up the same way if you want to keep that.

### 9.5 Other projects (Tabayyun, …)

One GlitchTip serves all your apps. Per app: create a project in GlitchTip (Settings → Projects;
a second organization only if you want separate member lists), copy its DSN and add the
official Sentry SDK of the app's language. Nothing else changes on the server.

| App stack        | SDK                                  | Minimal setup                                                                    |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Python / FastAPI | `sentry-sdk`                         | `sentry_sdk.init(dsn=os.environ["SENTRY_DSN"], release=os.environ["VERSION"])`   |
| Node (plain)     | `@sentry/node`                       | `Sentry.init({ dsn: process.env.SENTRY_DSN, release })`                          |
| Browser / React  | `@sentry/browser` or `@sentry/react` | `Sentry.init({ dsn, release })`; a tunnel like Suffa's `/api/errors` is optional |

- Keep the DSN in the app's environment variables (never in the repo).
- Send `release` (the image tag) and `environment` so every error names the deployed version.
- Turn off personal data: Python `send_default_pii=False` (default); JavaScript v11
  `dataCollection` as in `apps/web/src/services/errorTracking.ts`.
- Add an uptime monitor per app (§9.4).
- Registration stays closed: invite other people from GlitchTip (Organization → Members).
  A second organization needs `ENABLE_ORGANIZATION_CREATION=True` for a moment (App Configs),
  then set it back to `False`.

## 10. Capacity (each server)

Tabayyun's guidance is 2 vCPU / 4 GB for its api + web. Suffa adds roughly 1–1.5 GB RAM
(api, worker, Postgres). Transcoding is CPU-heavy: keep `SUFFA_TRANSCODE_CONCURRENCY=1` (Zoom recordings are
mostly copied, not re-encoded); transcription runs at Mistral (§11). Recommended: **8 GB
RAM / 4 vCPU** for both apps together; watch disk (RustFS holds recordings for both).
GlitchTip adds about 300–500 MB RAM (app + its Postgres) and a little disk for 90 days of events,
on the staging and tools server only. Production carries the three projects' production apps,
their databases, RustFS and WAL-G; size its disk for Postgres plus local WAL.

## 11. Transcription and summaries (EU only)

Recordings and their transcripts never go to a US provider (owner decision 2026-09-26).
Both run at Mistral (La Plateforme, EU); no server of our own is needed.

1. **API key:** Mistral console → La Plateforme → API Keys → "Create new key" (the
   workspace needs an active plan/billing). Keep it only in CapRover.
2. **Set on `suffa-api` and `suffa-worker`:**

   | Variable                    | Value                                                           |
   | --------------------------- | --------------------------------------------------------------- |
   | `SUFFA_MISTRAL_API_KEY`     | the key from step 1                                             |
   | `SUFFA_TRANSCRIBE_URL`      | `https://api.mistral.ai/v1/audio/transcriptions`                |
   | `SUFFA_TRANSCRIBE_MODEL`    | `voxtral-mini-latest` (or the exact Voxtral Mini Transcribe id) |
   | `SUFFA_TRANSCRIBE_LANGUAGE` | leave empty: Voxtral detects German and Arabic itself           |

   `SUFFA_TRANSCRIBE_TOKEN` is not needed: the api uses `SUFFA_MISTRAL_API_KEY` for Mistral.
   After the restart the api logs `transcribe.enabled` with host and model.

3. **In the class**, the teacher switches on "KI für Transkripte". New recordings are then
   transcribed after processing; existing ones via "Automatisch erstellen (KI)" in the
   player. The transcript appears under the player with the current line marked.

**Summaries and suggestions** (the "Zusammenfassung (KI)" and "Vorschläge holen" buttons in
the player) run on Mistral as soon as `SUFFA_MISTRAL_API_KEY` is set: `recording.summarize`
and `recording.suggest` route to `ministral-14b-latest`, then `ministral-8b-latest` (once
the Mistral tier includes Medium, switch to `mistral-medium-latest` in admin → KI); the
Anthropic routes for these tasks are switched off (admin → KI shows them). A summary is a
draft until the teacher publishes it for the class.

The api speaks the OpenAI-compatible transcription protocol, so another EU service needs
only a new URL, model and `SUFFA_TRANSCRIBE_TOKEN`. Recordings go out over https only
(plain http is accepted for localhost, in development). `SUFFA_TRANSCRIBE_LANGUAGE` is
ignored for Voxtral, which returns timestamps only when it detects the language itself.

## Troubleshooting

| Symptom                                                                                 | Cause                                                                                                         | Fix                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| API log `config.feature_off`                                                            | an optional feature (S3, Google, VAPID, FCM, app links) is only partly configured; it stays off, the API runs | set all variables of that group, or remove the partial ones                                                                                   |
| Web log `lookup srv-captain--suffa-api: no such host`                                   | app name/upstream mismatch                                                                                    | `SUFFA_API_UPSTREAM=srv-captain--<api app>:8000` (two dashes)                                                                                 |
| Media URLs return `SignatureDoesNotMatch`                                               | Host header not rewritten or endpoint differs between API and Caddy                                           | Same value for `SUFFA_S3_ENDPOINT` host and `SUFFA_MEDIA_UPSTREAM`; keep `header_up Host`                                                     |
| Media `AccessDenied`                                                                    | key policy misses a bucket or `ListBucket`                                                                    | Re-check policy in §2                                                                                                                         |
| Worker exits code 3 repeatedly                                                          | api not yet migrated / version mismatch                                                                       | Deploy api first; never run two api versions against one DB                                                                                   |
| No events in GlitchTip                                                                  | DSN missing/wrong, or HTTPS not enabled on `glitchtip`                                                        | Start log shows `"errorTracking":true`; run `node dist/error-test.js`; check the DSN                                                          |
| Browser errors missing, server errors arrive                                            | `SUFFA_WEB_ERROR_DSN` unset or the DSN of the wrong project                                                   | `https://<suffa>/api/client-config` must show the suffa-web DSN                                                                               |
| GlitchTip log `redis:6379` connection refused                                           | empty `VALKEY_URL` was dropped                                                                                | Add `VALKEY_URL` with an empty value, **Save & Update**                                                                                       |
| Transcript stays "Wartet auf den Start" / fails with "Worker ohne SUFFA_TRANSCRIBE_URL" | the transcription settings are on `suffa-api` only                                                            | set the same `SUFFA_TRANSCRIBE_*`/`SUFFA_MISTRAL_API_KEY` on `suffa-worker`; after 10 minutes without progress the teacher can start it again |
| API refuses to start in prod                                                            | placeholder or short secret                                                                                   | Generate secrets as above, **Save & Update**                                                                                                  |

## Sign-in mails (magic link)

Suffa signs people in with a link by email only (ADR-0008); there are no passwords. The api
sends the mails through the **Google Workspace SMTP relay**, the same setup as Tabayyun.

**1. Relay in the Workspace admin console** (admin.google.com → Apps → Google Workspace →
Gmail → Routing → **SMTP relay service** → Add another / edit the Tabayyun rule):

- _Allowed senders:_ "Only addresses in my domains".
- _Authentication:_ "Only accept mail from the specified IP addresses" with the public IP of the
  CapRover server, and/or "Require SMTP Authentication" (then a Workspace user with an app
  password is needed).
- _Encryption:_ "Require TLS encryption".

If Tabayyun's rule already allows the server's IP, Suffa can use it as is (same server).

**2. Environment of `suffa-api`** (App Configs → Environment variables):

| Name                                     | Value                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SUFFA_SMTP_HOST`                        | `smtp-relay.gmail.com`                                                                     |
| `SUFFA_SMTP_PORT`                        | `587` (STARTTLS, enforced; default) or `465` (implicit TLS). Many hosts block outgoing 465 |
| `SUFFA_MAIL_FROM`                        | `Suffa <noreply@your-domain>` – any address of the Workspace domain                        |
| `SUFFA_SMTP_USER`, `SUFFA_SMTP_PASSWORD` | only with "Require SMTP Authentication": the user and its app password                     |
| `SUFFA_PUBLIC_URL`                       | `https://suffa.<domain>`; its host name is also the relay greeting (EHLO)                  |
| `SUFFA_TRUSTED_ORIGINS`                  | optional: more addresses the app is served from, comma-separated (e.g. the old domain)     |

**3. Restart** the app. The log shows `auth.enabled` with `mail: smtp`. Without host and sender
it logs `auth.disabled`; the app keeps working offline, only sign-in and sync stay off.

The relay answers `550 5.7.0 Mail relay denied` when neither the IP rule nor authentication
matches, and `421 4.7.0 Try again later, closing connection. (EHLO)` when the server greets with
a name Google does not accept – Suffa greets with the host of `SUFFA_PUBLIC_URL`. Failed sends
are logged as `mail.send_failed` with host, port and the SMTP answer; `ETIMEDOUT` or `ESOCKET`
there means the outgoing port is blocked by the host (common for 465 and 25) – use `587`. A
sign-in request answered with `403 INVALID_ORIGIN` means `SUFFA_PUBLIC_URL` differs from the
address in the browser (or is missing from `SUFFA_TRUSTED_ORIGINS`); `auth.enabled` logs the
origins the api accepts. **Moving to a new domain:** set `SUFFA_PUBLIC_URL` to the new address
(sign-in mails and invite links point there) and list the old one in `SUFFA_TRUSTED_ORIGINS`
until nobody uses it. Browsers keep data and sign-in per domain: on the new address learners
sign in once more, and sync brings their progress over. Passkeys are bound to the host of
`SUFFA_PUBLIC_URL` (ADR-0008, update 2026-09-26): after a domain move they stop working, and
learners add a new one after signing in with link or code. Staging and production have
different hosts, so a passkey made on staging never opens production. Secrets live
only in CapRover, never in the repository. Outside prod the api may run without SMTP: the
sign-in link is then written to the log (`auth.magic_link_logged`) for local testing.
