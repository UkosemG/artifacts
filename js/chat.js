// The "Ask Claude" panel: sends the card's context plus the conversation to the Worker
// proxy, which holds the API key and streams Claude's answer back as SSE.

import { CONFIG, isChatConfigured } from '../config.js';
import { el, clear, show, hide } from './ui.js';
import { getFreshCredential } from './auth.js';

const MAX_TURNS = 20;

const dom = {};
let currentPost = null;
let transcript = [];
let inFlight = null;
let previewMode = false;

export function initChat({ preview = false } = {}) {
  previewMode = preview;

  dom.panel = document.getElementById('chat-panel');
  dom.backdrop = document.getElementById('chat-backdrop');
  dom.title = document.getElementById('chat-title');
  dom.transcript = document.getElementById('chat-transcript');
  dom.chips = document.getElementById('chat-chips');
  dom.composer = document.getElementById('chat-composer');
  dom.input = document.getElementById('chat-input');
  dom.send = document.getElementById('chat-send');
  dom.close = document.getElementById('chat-close');

  dom.close.addEventListener('click', closeChat);
  dom.backdrop.addEventListener('click', closeChat);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.panel.hidden) closeChat();
  });

  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = dom.input.value.trim();
    if (text) send(text);
  });

  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      dom.composer.requestSubmit();
    }
  });

  dom.input.addEventListener('input', () => {
    dom.input.style.height = 'auto';
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, 140)}px`;
  });
}

function chatAvailable() {
  return isChatConfigured() && !previewMode;
}

function bubble(kind, text) {
  const node = el('div', { class: `bubble bubble--${kind}` }, text ? [text] : []);
  dom.transcript.append(node);
  dom.transcript.scrollTop = dom.transcript.scrollHeight;
  return node;
}

function setBusy(busy) {
  dom.send.disabled = busy;
  dom.send.textContent = busy ? 'Thinking…' : 'Send';
  dom.chips.querySelectorAll('button').forEach((b) => {
    b.disabled = busy;
  });
}

export function openChat(post, seedPrompt) {
  currentPost = post;
  transcript = [];

  dom.title.textContent = post.title;
  clear(dom.transcript);
  clear(dom.chips);

  if (!chatAvailable()) {
    const reason = previewMode
      ? 'Chat is disabled in preview mode. Sign in on the deployed site to use it.'
      : 'Claude chat isn’t set up yet — deploy the chat worker and fill in CHAT_PROXY_URL in config.js (see SETUP.md).';
    bubble('note', reason);
    dom.composer.dataset.disabled = 'true';
  } else {
    delete dom.composer.dataset.disabled;
    bubble(
      'note',
      'Claude sees this card’s title, description and facts — not the live dashboard behind it.'
    );

    for (const prompt of post.actions || []) {
      dom.chips.append(
        el('button', { type: 'button', class: 'chip', onclick: () => send(prompt) }, [prompt])
      );
    }
  }

  show(dom.backdrop);
  show(dom.panel);
  document.body.style.overflow = 'hidden';

  if (chatAvailable()) {
    if (seedPrompt) {
      dom.input.value = seedPrompt;
      dom.input.dispatchEvent(new Event('input'));
    }
    dom.input.focus();
  }
}

export function closeChat() {
  inFlight?.abort();
  inFlight = null;
  hide(dom.panel);
  hide(dom.backdrop);
  document.body.style.overflow = '';
  dom.input.value = '';
  dom.input.style.height = 'auto';
  setBusy(false);
}

function contextForPost(post) {
  return {
    title: post.title,
    description: post.description,
    facts: post.facts,
    artifactUrl: post.artifactUrl,
  };
}

// Reads the Anthropic SSE stream and appends text deltas into `target`.
async function streamInto(target, response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  target.classList.add('bubble--pending');

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
          text += event.delta.text;
          target.textContent = text;
          dom.transcript.scrollTop = dom.transcript.scrollHeight;
        } else if (event.type === 'error') {
          throw new Error(event.error?.message || 'Claude returned an error.');
        }
      }
    }
  } finally {
    target.classList.remove('bubble--pending');
  }

  return text;
}

async function send(text) {
  if (!chatAvailable() || !currentPost) return;

  dom.input.value = '';
  dom.input.style.height = 'auto';
  bubble('user', text);
  transcript.push({ role: 'user', content: text });
  if (transcript.length > MAX_TURNS) transcript = transcript.slice(-MAX_TURNS);

  setBusy(true);

  const credential = await getFreshCredential();
  if (!credential) {
    setBusy(false);
    bubble('error', 'Your session expired. Sign out and back in to keep chatting.');
    return;
  }

  const target = bubble('claude', '');
  inFlight = new AbortController();

  try {
    const response = await fetch(`${CONFIG.CHAT_PROXY_URL.replace(/\/$/, '')}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ context: contextForPost(currentPost), messages: transcript }),
      signal: inFlight.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(errorMessageFor(response.status, detail));
    }

    const answer = await streamInto(target, response);
    if (answer.trim()) {
      transcript.push({ role: 'assistant', content: answer });
    } else {
      target.remove();
      bubble('error', 'Claude returned an empty response. Try asking again.');
    }
  } catch (error) {
    target.remove();
    if (error.name === 'AbortError') return;

    const retryText = transcript[transcript.length - 1]?.content;
    const errorNode = bubble('error', error.message || 'Could not reach Claude.');
    errorNode.append(
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost',
          onclick: () => {
            errorNode.remove();
            transcript.pop();
            send(retryText);
          },
        },
        ['Retry']
      )
    );
  } finally {
    inFlight = null;
    setBusy(false);
  }
}

function errorMessageFor(status, detail) {
  if (status === 401) return 'Your session expired. Sign out and back in to keep chatting.';
  if (status === 403) return 'Your account is not allowed to use this chat.';
  if (status === 429) return 'Too many questions in a short window. Wait a moment and try again.';
  if (status >= 500) return 'The chat service had a problem. Try again in a moment.';
  return detail?.slice(0, 200) || `Chat request failed (${status}).`;
}
