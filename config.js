// App configuration. These values are public by design — the OAuth client ID and the
// chat proxy URL are visible to anyone who loads the page. The only real secret
// (the Anthropic API key) lives in the Cloudflare Worker, never here.
//
// Fill these in by following SETUP.md.

export const CONFIG = {
  // From Google Cloud Console → Credentials → OAuth 2.0 Client ID (Web application).
  GOOGLE_CLIENT_ID: 'REPLACE_ME.apps.googleusercontent.com',

  // Deployed Cloudflare Worker origin, e.g. 'https://bria-feed-chat.your-account.workers.dev'.
  // Leave empty to ship the feed without the embedded Claude chat.
  CHAT_PROXY_URL: '',

  // Only accounts on this Google Workspace domain may sign in.
  ALLOWED_DOMAIN: 'bria.ai',

  // Product name shown in the UI.
  APP_NAME: 'Bria Feed',
};

export function isAuthConfigured() {
  const id = CONFIG.GOOGLE_CLIENT_ID;
  return Boolean(id) && !id.startsWith('REPLACE_ME');
}

export function isChatConfigured() {
  return Boolean(CONFIG.CHAT_PROXY_URL);
}
