// Google Sign-In via Google Identity Services.
//
// IMPORTANT: everything here is a soft gate for UX only. The ID token payload is decoded
// client-side without verifying its signature — anyone can bypass this with devtools.
// The real boundary is the Cloudflare Worker, which verifies the token's signature and
// claims server-side before touching the Anthropic API. Dashboard content itself is
// protected by claude.ai artifact sharing, not by this gate.

import { CONFIG } from '../config.js';

const SESSION_KEY = 'briafeed.session.v1';
// Re-mint the ID token when it has under this long to live (tokens last ~1h).
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let gisReady = null;
let onSignedIn = null;
let onRejected = null;

function decodeJwtPayload(token) {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function domainOf(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}

export function isAllowedUser(payload) {
  if (!payload || payload.email_verified !== true) return false;
  const domain = CONFIG.ALLOWED_DOMAIN.toLowerCase();
  // `hd` is only present on Google Workspace accounts; fall back to the email domain.
  if (payload.hd) return String(payload.hd).toLowerCase() === domain;
  return domainOf(payload.email) === domain;
}

function sessionFromPayload(payload, credential) {
  return {
    email: String(payload.email || '').toLowerCase(),
    name: payload.name || '',
    picture: payload.picture || '',
    exp: Number(payload.exp) || 0,
    credential,
  };
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable (private mode) — session just won't persist */
  }
}

export function restoreSession() {
  let raw = null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const session = JSON.parse(raw);
    if (!session?.email || domainOf(session.email) !== CONFIG.ALLOWED_DOMAIN.toLowerCase()) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    clearSession();
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function waitForGis() {
  if (gisReady) return gisReady;

  gisReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve(window.google.accounts.id);
      return;
    }

    const started = Date.now();
    const timer = setInterval(() => {
      if (window.google?.accounts?.id) {
        clearInterval(timer);
        resolve(window.google.accounts.id);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error('Google Sign-In failed to load'));
      }
    }, 100);
  });

  return gisReady;
}

function handleCredentialResponse(response) {
  const payload = decodeJwtPayload(response?.credential);

  if (!payload) {
    onRejected?.('Could not read the Google sign-in response. Try again.');
    return;
  }

  if (!isAllowedUser(payload)) {
    disableAutoSelect();
    clearSession();
    onRejected?.(
      `${payload.email || 'That account'} isn't a ${CONFIG.ALLOWED_DOMAIN} account. Sign in with your Bria account.`
    );
    return;
  }

  const session = sessionFromPayload(payload, response.credential);
  saveSession(session);
  onSignedIn?.(session);
}

// Initialize GIS and render the sign-in button into `buttonEl`.
export async function initGoogleSignIn(buttonEl, handlers = {}) {
  onSignedIn = handlers.onSignedIn;
  onRejected = handlers.onRejected;

  const gis = await waitForGis();

  gis.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: true,
    cancel_on_tap_outside: false,
    use_fedcm_for_prompt: true,
  });

  if (buttonEl) {
    gis.renderButton(buttonEl, {
      theme: 'filled_black',
      size: 'large',
      shape: 'pill',
      text: 'signin_with',
      logo_alignment: 'left',
    });
  }

  // One Tap is a bonus on top of the rendered button; ignore failures.
  try {
    gis.prompt();
  } catch {
    /* ignore */
  }
}

export function disableAutoSelect() {
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch {
    /* ignore */
  }
}

export function signOut() {
  disableAutoSelect();
  clearSession();
}

// Returns a currently-valid ID token, re-minting via GIS if the stored one is near expiry.
// Resolves null when no fresh token can be obtained (caller should ask the user to sign in).
export async function getFreshCredential() {
  const session = restoreSession();
  if (!session) return null;

  const expiresAt = session.exp * 1000;
  if (expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.credential;

  const renewed = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const previous = onSignedIn;
    onSignedIn = (newSession) => {
      onSignedIn = previous;
      previous?.(newSession);
      finish(newSession.credential);
    };

    try {
      window.google?.accounts?.id?.prompt(() => {
        // Notification callback fires for dismissed/skipped moments too; the timeout below
        // is the real guard, so nothing to do here.
      });
    } catch {
      finish(null);
    }

    setTimeout(() => {
      onSignedIn = previous;
      finish(null);
    }, 6000);
  });

  return renewed;
}
