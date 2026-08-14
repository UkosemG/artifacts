# Setting up Bria Feed

Three things to do, in this order. The first gets the feed live, the second adds
sign-in, the third turns on the embedded Claude chat. You can stop after any step —
the app degrades gracefully and tells you what's missing.

Until then, you can see the whole app locally with sign-in bypassed:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/?preview=1
```

---

## 1. Publish the site (GitHub Pages)

The app is plain static files — no build step.

1. In the repo: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.
2. Merge this branch into `main`. Pages serves `main`, so the branch alone won't be live.
3. Your URL will be `https://ukosemg.github.io/artifacts/`. Note it — the next two steps need it.

The feed will load and show the seeded demo cards, with a "setup needed" sign-in screen.

---

## 2. Turn on Google Sign-In

### Create the OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), pick (or create) a project.
2. Configure the **OAuth consent screen**: Internal user type, so only `bria.ai` accounts can use it.
3. **Create Credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins**, add both:
   - `https://ukosemg.github.io`
   - `http://localhost:8000` (for local testing)
   Leave **Authorized redirect URIs** empty — Google Identity Services doesn't use them here.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### Fill it in

Edit `config.js`:

```js
GOOGLE_CLIENT_ID: '123456789-abcdef.apps.googleusercontent.com',
```

Commit and push. Sign-in now works, restricted to `@bria.ai`.

> The client ID is public by design — it identifies your app, it doesn't authorize
> anything on its own. It's safe in a public repo.

---

## 3. Turn on the embedded Claude chat

The chat needs an Anthropic API key, and a static site can't hold a secret. The
Cloudflare Worker in `worker/` holds the key, checks that the caller is a signed-in
`@bria.ai` user, and relays to Claude. Free tier is plenty for internal use.

### Deploy the worker

```bash
npm install -g wrangler        # once
cd worker
wrangler login                 # opens a browser

# Edit wrangler.toml first:
#   ALLOWED_ORIGIN  -> https://ukosemg.github.io  (add ,http://localhost:8000 to test locally)
#   GOOGLE_CLIENT_ID -> the same client ID you put in config.js

wrangler secret put ANTHROPIC_API_KEY    # paste your key from console.anthropic.com
wrangler deploy
```

Wrangler prints the worker URL, e.g. `https://bria-feed-chat.your-account.workers.dev`.

### Turn on shared comments (same worker)

Comments need somewhere shared to live, or everyone only sees their own. One
command creates it:

```bash
wrangler kv namespace create COMMENTS
```

Wrangler prints an `id`. Paste it into `wrangler.toml` and uncomment those three
lines:

```toml
[[kv_namespaces]]
binding = "COMMENTS"
id = "the-id-wrangler-printed"
```

Then `wrangler deploy` again. Skip this and the feed still works — comments just
stay on each person's own device, and the app says so.

### Point the app at it

Edit `config.js`:

```js
CHAT_PROXY_URL: 'https://bria-feed-chat.your-account.workers.dev',
```

Commit and push. "Ask Claude" and comments are now live.

### Smoke tests

```bash
WORKER=https://bria-feed-chat.your-account.workers.dev

# 1. Is it up?
curl -s $WORKER/healthz
# {"ok":true,"service":"bria-feed-chat"}

# 2. Does it reject a bogus token? (expect 401)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $WORKER/chat \
  -H 'authorization: Bearer not-a-real-token' \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'

# 3. Does CORS block a foreign origin? (expect no access-control-allow-origin header)
curl -si -X OPTIONS $WORKER/chat -H 'Origin: https://evil.example' | grep -i access-control-allow-origin
```

### Local worker testing

```bash
cd worker
cp .dev.vars.example .dev.vars      # add your real key; .dev.vars is gitignored
wrangler dev
```

---

## Publishing a dashboard to the feed

1. Build the dashboard as a Claude artifact and keep it private (artifact sharing is
   what actually controls who can see the data).
2. Add an entry to `data/feed.json` — copy an existing post and change the fields:

   ```json
   {
     "id": "2026-08-20-gtm-winrate",
     "channel": "gtm",
     "title": "Win Rate by Segment",
     "description": "One line on what the dashboard shows.",
     "facts": [{ "label": "Win rate", "value": "24%" }],
     "artifactUrl": "https://claude.ai/artifacts/…",
     "author": "you@bria.ai",
     "publishedAt": "2026-08-20T09:00:00Z",
     "actions": ["A question worth asking about this dashboard"]
   }
   ```

3. Commit and push to `main`. The feed picks it up on the next load.

Channels live in the same file. To add a business unit, add a `channels` entry with a
new `id` and use that id on posts. Personal channels use `"type": "personal"` with the
owner's email — the signed-in user sees their own first, labelled "My channel".

Ask Claude to do all of this for you: *"add my Q4 forecast dashboard to the GTM channel
in the feed."*

---

## What's public and what isn't

The repo is public, so treat everything in it as readable by anyone:

- **`data/feed.json` is public** — card titles, descriptions, and the key figures on
  them. Keep the facts non-sensitive; they're a teaser, not the data.
- **`config.js` is public** — the OAuth client ID and worker URL are public by design.
- **The dashboards themselves are not public.** They live on claude.ai and are governed
  by artifact sharing. That's the real access control.
- **The only secret is the Anthropic API key**, and it lives in Cloudflare Worker
  secrets — never in this repo.

The sign-in gate on the site is a convenience, not a security boundary: it's
client-side and can be bypassed with devtools. The worker is the enforced boundary —
it verifies the Google token's signature and domain server-side before spending a
single API token.

## Known limits

- The worker's rate limiting is best-effort per-isolate (~20 requests / 5 min per
  person). Fine for an internal tool; a determined insider could exceed it. Cloudflare
  KV or Durable Objects would make it strict.
- Google ID tokens last about an hour. The app re-mints silently in the background; if
  that fails, the chat asks you to sign in again.
- `artifacts.json` in this repo is generated by another app and may be overwritten at
  any time. The feed reads it if present and ignores it otherwise — never edit it here.
