# Deploying the API (gives you the public URL)

The `cti-api` server is the only thing that needs hosting — it also serves the
Salesforce softphone at `/cti/`. The Dockerfile + `railway.json` in this repo
are validated and ready. Recommended host: **Railway** (you're already logged
in; deploys straight from this folder, managed Postgres, stable URL).

> Why not Vercel/Netlify? The firewall's background workers (auto-pause +
> Salesforce sync) need an always-on server, not serverless functions.

## One-time deploy (Railway)

```bash
cd /Users/cdrshepard/spam-res-cti

# 1. Create a project (and link this folder to it)
railway init                       # name it e.g. "caller-reputation-cti"

# 2. Add a managed Postgres
railway add --database postgres

# 3. Generate two secrets — copy each value
openssl rand -hex 32               # -> TOKEN_ENCRYPTION_KEY (64 hex chars)
openssl rand -hex 32               # -> SESSION_SECRET
openssl rand -hex 24               # -> NUMBERVERIFIER_VERIFY_KEY (any strong string)

# 4. Set environment variables (or paste them in the Railway dashboard → Variables)
railway variables \
  --set "NODE_ENV=production" \
  --set "TOKEN_ENCRYPTION_KEY=<paste>" \
  --set "SESSION_SECRET=<paste>" \
  --set "DATABASE_URL=${{Postgres.DATABASE_URL}}" \
  --set "NUMBERVERIFIER_VERIFY_KEY=<paste>" \
  --set "TWILIO_ACCOUNT_SID=<...>" \
  --set "TWILIO_AUTH_TOKEN=<...>" \
  --set "TWILIO_API_KEY_SID=<...>" \
  --set "TWILIO_API_KEY_SECRET=<...>" \
  --set "TWILIO_TWIML_APP_SID=<...>" \
  --set "TWILIO_DEFAULT_CALLER_ID=+1..."

# 5. Deploy from this folder, then mint a public domain
railway up
railway domain                     # -> https://<something>.up.railway.app

# 6. Tell the app its own public URL, then redeploy so webhooks use it
railway variables --set "API_PUBLIC_URL=https://<something>.up.railway.app"
railway up
```

`DATABASE_URL=${{Postgres.DATABASE_URL}}` is a Railway variable reference — it
auto-fills from the Postgres you added. Migrations run automatically on each
boot (the container's start command).

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
