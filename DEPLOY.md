# Deploying the API (gives you the public URL)

The `cti-api` server is the only thing that needs hosting — it also serves the
Salesforce softphone at `/cti/`. The Dockerfile + `railway.json` in this repo
are validated and ready. Recommended host: **Railway** (you're already logged
in; deploys straight from this folder, managed Postgres, stable URL).

> Why not Vercel/Netlify? The firewall's background workers (auto-pause +
> Salesforce sync) need an always-on server, not serverless functions.

## Deploy from GitHub (recommended)

Repo: `https://github.com/CDR-Shepard/spam-res-cti`. Railway reads `railway.json`
and builds with the `Dockerfile` automatically — no build config to pick.

1. **railway.com → New Project → Deploy from GitHub repo →** `CDR-Shepard/spam-res-cti`.
   It detects the Dockerfile; let the first build run (it will crash-loop until
   you add the DB + variables in the next steps — that's expected).
2. **+ New → Database → Add PostgreSQL** in the same project.
3. Generate three secrets locally and copy each value:
   ```bash
   openssl rand -hex 32   # TOKEN_ENCRYPTION_KEY (64 hex chars)
   openssl rand -hex 32   # SESSION_SECRET
   openssl rand -hex 24   # NUMBERVERIFIER_VERIFY_KEY
   ```
4. Open the **API service → Variables** and add:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the Postgres you added) |
   | `TOKEN_ENCRYPTION_KEY` | the 64-hex value |
   | `SESSION_SECRET` | the 32-byte value |
   | `NUMBERVERIFIER_VERIFY_KEY` | the secret you'll also paste into NumberVerifier |
   | `TWILIO_ACCOUNT_SID` … `TWILIO_DEFAULT_CALLER_ID` | from your Twilio console |
   | `SALESFORCE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | if using Salesforce |

5. **Settings → Networking → Generate Domain.** Copy `https://<name>.up.railway.app`.
6. Add one more variable `API_PUBLIC_URL=https://<name>.up.railway.app` and let it
   redeploy (so webhook/voice URLs use the real host). Migrations run on every boot.

> The build is already validated locally (the Docker image builds and the server
> boots to a clean "missing env" error). If the deploy logs show
> `Invalid environment configuration`, a variable above is missing.

### Alternative: deploy from this folder via the CLI

```bash
railway init && railway add --database postgres
railway variables --set "NODE_ENV=production" --set "DATABASE_URL=${{Postgres.DATABASE_URL}}" --set "..."
railway up && railway domain
```

## After it's live — point everything at `https://<domain>`

| Where | Set to |
|---|---|
| **NumberVerifier** → Webhooks | URL `https://<domain>/integrations/numberverifier/webhook`, Verify Key = your `NUMBERVERIFIER_VERIFY_KEY`, Version `v2` |
| **Twilio** → TwiML App Voice URL | `https://<domain>/telephony/twilio/voice` |
| **Twilio** → TwiML App Status URL | `https://<domain>/telephony/twilio/status` |
| **Twilio** → inbound number webhook | `https://<domain>/telephony/twilio/inbound` |
| **Salesforce** → `apps/cti-web/CallCenter.xml` adapterUrl | `https://<domain>/cti/` (re-import the Call Center) |
| Salesforce Connected App callback | `https://<domain>/auth/salesforce/callback` |

Optionally also set `CORS_ALLOWED_ORIGINS` to your Salesforce my-domain and
`ALERT_WEBHOOK_URL` to a Slack incoming webhook.

## Just testing today? (no deploy)

Run the API locally, then expose it with the tunnel you already have:

```bash
cloudflared tunnel --url http://localhost:4000   # prints an https URL
```

Use that URL the same way as the table above. Note: it only works while your
laptop + the tunnel + the API are running, and the URL changes each restart.
