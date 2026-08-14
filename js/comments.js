// Comments, Instagram-style: a count on the card, a bottom sheet with the thread.
//
// Comments are shared, so they live in the Cloudflare Worker (KV-backed) whenever
// it's configured. Without it — preview mode, or before the worker is deployed —
// they fall back to this browser's localStorage so the feature is still explorable,
// and the sheet says so rather than pretending the thread is shared.

import { CONFIG, isChatConfigured } from '../config.js';
import { el, clear, show, hide, formatRelativeTime, initials, displayNameFromEmail } from './ui.js';
import { getFreshCredential } from './auth.js';

const LOCAL_KEY = 'briafeed.comments.v1';
const MAX_LENGTH = 1000;

const dom = {};
const cache = new Map(); // postId -> comment[]
let currentPost = null;
let currentUser = null;
let previewMode = false;

function shared() {
  return isChatConfigured() && !previewMode;
}

/* ---------- local fallback ---------- */

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLocal(all) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    /* storage full or unavailable — comment just won't persist */
  }
}

/* ---------- transport ---------- */

async function fetchComments(postId) {
  if (!shared()) return readLocal()[postId] || [];

  const credential = await getFreshCredential();
  if (!credential) throw new Error('session-expired');

  const url = `${CONFIG.CHAT_PROXY_URL.replace(/\/$/, '')}/comments?post=${encodeURIComponent(postId)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${credential}` } });
  if (!res.ok) throw new Error(`load-failed-${res.status}`);

  const body = await res.json();
  return Array.isArray(body.comments) ? body.comments : [];
}

async function postComment(postId, text) {
  const comment = {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    postId,
    author: currentUser?.email || 'unknown',
    name: currentUser?.name || displayNameFromEmail(currentUser?.email || ''),
    text,
    createdAt: new Date().toISOString(),
  };

  if (!shared()) {
    const all = readLocal();
    all[postId] = [...(all[postId] || []), comment];
    writeLocal(all);
    return comment;
  }

  const credential = await getFreshCredential();
  if (!credential) throw new Error('session-expired');

  const res = await fetch(`${CONFIG.CHAT_PROXY_URL.replace(/\/$/, '')}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ postId, text }),
  });
  if (!res.ok) throw new Error(`post-failed-${res.status}`);

  const body = await res.json();
  return body.comment || comment;
}

/* ---------- card count line ---------- */

function labelFor(count) {
  if (count === 0) return 'Add a comment…';
  if (count === 1) return 'View 1 comment';
  return `View all ${count} comments`;
}

function paintCount(postId, count) {
  document
    .querySelectorAll(`[data-comment-count-for="${CSS.escape(postId)}"]`)
    .forEach((node) => {
      node.textContent = labelFor(count);
      node.classList.toggle('comment-line--has', count > 0);
    });
}

// Load counts for everything on screen, quietly. A failure here leaves the
// default "Add a comment…" label, which is still a working button.
export async function primeCounts(posts) {
  for (const post of posts) {
    try {
      const comments = await fetchComments(post.id);
      cache.set(post.id, comments);
      paintCount(post.id, comments.length);
    } catch {
      /* leave the default label */
    }
  }
}

/* ---------- sheet ---------- */

function renderComment(comment) {
  const who = comment.name || displayNameFromEmail(comment.author);
  return el('li', { class: 'comment' }, [
    el('span', { class: 'comment-avatar', 'aria-hidden': 'true' }, [initials(who)]),
    el('div', { class: 'comment-body' }, [
      el('p', { class: 'comment-text' }, [
        el('span', { class: 'comment-author' }, [who]),
        ' ',
        comment.text,
      ]),
      el('time', { class: 'comment-time', datetime: comment.createdAt }, [
        formatRelativeTime(comment.createdAt),
      ]),
    ]),
  ]);
}

function paintThread(comments) {
  clear(dom.list);

  if (comments.length === 0) {
    dom.list.append(
      el('li', { class: 'comment-empty' }, ['No comments yet. Start the conversation.'])
    );
  } else {
    for (const comment of comments) dom.list.append(renderComment(comment));
  }

  if (!shared()) {
    dom.list.append(
      el('li', { class: 'comment-note' }, [
        previewMode
          ? 'Preview mode — comments stay on this device.'
          : 'Comments are saved on this device only until the chat worker is deployed (see SETUP.md).',
      ])
    );
  }
}

export function openComments(post) {
  currentPost = post;
  dom.title.textContent = post.title;
  clear(dom.list);
  dom.list.append(el('li', { class: 'comment-empty' }, ['Loading…']));

  show(dom.backdrop);
  show(dom.sheet);
  document.body.style.overflow = 'hidden';

  const cached = cache.get(post.id);
  if (cached) paintThread(cached);

  fetchComments(post.id)
    .then((comments) => {
      cache.set(post.id, comments);
      paintCount(post.id, comments.length);
      if (currentPost?.id === post.id) paintThread(comments);
    })
    .catch(() => {
      if (currentPost?.id !== post.id) return;
      clear(dom.list);
      dom.list.append(
        el('li', { class: 'comment-empty' }, ['Could not load comments. Try again in a moment.'])
      );
    });

  dom.input.focus();
}

export function closeComments() {
  currentPost = null;
  hide(dom.sheet);
  hide(dom.backdrop);
  document.body.style.overflow = '';
  dom.input.value = '';
}

async function submit(event) {
  event.preventDefault();
  const text = dom.input.value.trim();
  if (!text || !currentPost) return;
  if (text.length > MAX_LENGTH) return;

  const post = currentPost;
  dom.input.value = '';
  dom.send.disabled = true;

  try {
    const comment = await postComment(post.id, text);
    const next = [...(cache.get(post.id) || []), comment];
    cache.set(post.id, next);
    paintCount(post.id, next.length);
    if (currentPost?.id === post.id) paintThread(next);
  } catch (error) {
    dom.input.value = text;
    const message =
      error.message === 'session-expired'
        ? 'Your session expired. Sign out and back in to comment.'
        : 'Could not post that comment. Try again.';
    dom.list.append(el('li', { class: 'comment-note comment-note--error' }, [message]));
  } finally {
    dom.send.disabled = false;
  }
}

export function initComments({ preview = false, user = null } = {}) {
  previewMode = preview;
  currentUser = user;

  dom.sheet = document.getElementById('comments-sheet');
  dom.backdrop = document.getElementById('comments-backdrop');
  dom.title = document.getElementById('comments-title');
  dom.list = document.getElementById('comments-list');
  dom.form = document.getElementById('comments-form');
  dom.input = document.getElementById('comments-input');
  dom.send = document.getElementById('comments-send');
  dom.close = document.getElementById('comments-close');

  dom.close.addEventListener('click', closeComments);
  dom.backdrop.addEventListener('click', closeComments);
  dom.form.addEventListener('submit', submit);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.sheet.hidden) closeComments();
  });
}
