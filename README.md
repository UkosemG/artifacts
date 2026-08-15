# Bria Feed

An internal, Instagram-style feed of dashboards for Bria. Channels along the top
(company, business units, personal), a scrollable feed of cards below. Each card
carries the headline facts and opens the full dashboard — a Claude artifact — in one
tap, with an "Ask Claude" panel for acting on what you see.

Static site, no build step, served by GitHub Pages from `main` / root.

## Getting it running

See **[SETUP.md](./SETUP.md)** — GitHub Pages, the Google OAuth client, and the
Cloudflare Worker that powers the chat. Each step is optional; the app degrades
gracefully and tells you what's missing.

To look at the app locally without any configuration:

```bash
python3 -m http.server 8000
# http://localhost:8000/?preview=1   (bypasses sign-in; chat stays off)
```

## Layout

```
index.html        app shell: sign-in gate, feed, chat panel
style.css         Bria design system tokens, mobile-first
config.js         GOOGLE_CLIENT_ID / CHAT_PROXY_URL / ALLOWED_DOMAIN  ← fill these in
js/               main.js (boot) · auth.js · store.js · feed.js · chat.js · ui.js
data/feed.json    channels and posts — this is what you edit to publish a dashboard
worker/           Cloudflare Worker: verifies the Google token, relays to Claude
scripts/          check-feed.mjs — validates the feed and keeps figures off cards
artifacts.json    generated elsewhere (see below)
```

Run the checks the way CI does:

```bash
node scripts/check-feed.mjs        # validate data/feed.json
node scripts/check-feed.test.mjs   # prove the checker still catches violations
```

## Publishing a dashboard

Add an entry to `data/feed.json` and push — the format and a worked example are in
[SETUP.md](./SETUP.md#publishing-a-dashboard-to-the-feed). Easiest path is to ask
Claude: *"add my Q4 forecast dashboard to the GTM channel in the feed."*

## A note on what's public

This repo is public, so everything in `data/feed.json` is readable by anyone. Cards
carry counts, cadence and dates — never revenue, targets, pipeline, deal sizes or
customer names. Those belong in the linked Claude artifact, where artifact sharing is
the real access control. The sign-in gate here is UX; the worker is the enforced
boundary. Full detail in [SETUP.md](./SETUP.md#whats-public-and-what-isnt).

`scripts/check-feed.mjs` enforces the figures half of that rule in CI: currency
amounts, abbreviated amounts like `4M`, comma-grouped numbers, and finance words
carrying a quantity all fail the build. It cannot check for customer names — a
denylist of those would leak them into this same public repo — so that part stays a
human rule.

## `artifacts.json`

Generated and pushed automatically by the `admin/` app in the
[evelabs-first](https://github.com/UkosemG/evelabs-first) repo whenever changes are
published — **don't edit it by hand, it will be overwritten on the next publish.**
The feed reads it if it's present (entries show up as cards in the company channel)
and carries on fine if it isn't.
