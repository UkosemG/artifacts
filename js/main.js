// Boot + state machine: gate → feed → chat.

import { CONFIG, isAuthConfigured } from '../config.js';
import * as store from './store.js';
import * as auth from './auth.js';
import { initChat, openChat, closeChat } from './chat.js';
import { initComments, openComments, closeComments, primeCounts } from './comments.js';
import {
  renderStories, renderLevels, renderFeed, renderGrid, renderLoading, renderFeedError,
} from './feed.js';
import { el, clear, show, hide, initials, displayNameFromEmail, toast } from './ui.js';

const VIEW_KEY = 'briafeed.view.v1';
const LEVEL_KEY = 'briafeed.level.v1';

const dom = {};
let currentUser = null;
let activeChannel = 'all';
let dataReady = null;
let previewMode = false;
// Grid opens first: it answers "what's here" in one screen, where the reel
// shows one post and makes you scroll to find anything.
let view = 'grid';
// All levels by default — narrowing is a choice the reader makes.
let activeLevel = 'all';

function cacheDom() {
  dom.gate = document.getElementById('gate');
  dom.gateNote = document.getElementById('gate-note');
  dom.gateRetry = document.getElementById('gate-retry');
  dom.gsiButton = document.getElementById('gsi-button');
  dom.app = document.getElementById('app');
  dom.stories = document.getElementById('stories');
  dom.feed = document.getElementById('feed');
  dom.levels = document.getElementById('levels');
  dom.tabGrid = document.getElementById('tab-grid');
  dom.tabReel = document.getElementById('tab-reel');
  dom.topbarUser = document.getElementById('topbar-user');
  dom.signout = document.getElementById('signout-btn');
}

function showGate(variant, note) {
  dom.gate.dataset.variant = variant;
  show(dom.gate);
  hide(dom.app);

  if (note) {
    clear(dom.gateNote);
    dom.gateNote.append(note instanceof Node ? note : document.createTextNode(note));
    show(dom.gateNote);
  } else {
    hide(dom.gateNote);
  }

  if (variant === 'wrong-domain') {
    show(dom.gateRetry);
  } else {
    hide(dom.gateRetry);
  }
}

function renderAvatar(user) {
  clear(dom.signout);
  if (user.picture) {
    dom.signout.append(
      el('img', { src: user.picture, alt: '', referrerpolicy: 'no-referrer' })
    );
  } else {
    dom.signout.textContent = initials(user.name || user.email);
  }
}

function renderCurrentView({ scrollToPostId } = {}) {
  const channels = store.getChannels(currentUser);
  const posts = store.getPosts(activeChannel, activeLevel, currentUser);
  const channel = store.getChannel(activeChannel);
  const isGrid = view === 'grid';

  renderStories(dom.stories, channels, activeChannel, { onSelect: selectChannel });
  renderLevels(dom.levels, store.countByLevel(activeChannel, currentUser), activeLevel, {
    onSelect: selectLevel,
  });

  dom.feed.classList.toggle('feed--grid', isGrid);
  dom.feed.classList.toggle('feed--reel', !isGrid);
  dom.tabGrid.setAttribute('aria-pressed', String(isGrid));
  dom.tabReel.setAttribute('aria-pressed', String(!isGrid));

  if (isGrid) {
    renderGrid(dom.feed, posts, channel, { channels, onOpenPost: openPost });
  } else {
    renderFeed(dom.feed, posts, channel, {
      channels,
      onAskClaude: (post, prompt) => openChat(post, prompt),
      onOpenComments: (post) => openComments(post),
    });
  }

  if (scrollToPostId) {
    const card = dom.feed.querySelector(`[data-post-id="${CSS.escape(scrollToPostId)}"]`);
    // One frame, so the snap container has laid out before we jump to the card.
    if (card) requestAnimationFrame(() => card.scrollIntoView({ block: 'start' }));
  } else {
    dom.feed.scrollTop = 0;
  }

  // Comment counts only exist on reel cards, so don't fetch them for a grid.
  if (!isGrid) primeCounts(posts);
}

function selectChannel(channelId) {
  activeChannel = channelId;
  renderCurrentView();
}

function selectLevel(level) {
  activeLevel = level;
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch {
    /* private browsing — the choice just won't survive a reload */
  }
  renderCurrentView();
}

function setView(next, opts) {
  if (next !== 'grid' && next !== 'reel') return;
  view = next;
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* private browsing — the choice just won't survive a reload */
  }
  renderCurrentView(opts);
}

// Tapping a tile is how you get from the index to the post.
function openPost(post) {
  setView('reel', { scrollToPostId: post.id });
}

async function enterApp(user) {
  currentUser = user;
  initComments({ preview: previewMode, user });
  hide(dom.gate);
  show(dom.app);

  dom.topbarUser.textContent = user.name || displayNameFromEmail(user.email);
  renderAvatar(user);
  renderLoading(dom.feed);

  try {
    await dataReady;
  } catch {
    renderFeedError(dom.feed, 'Feed unavailable — data/feed.json could not be loaded.');
    return;
  }

  activeChannel = 'all';
  selectChannel(activeChannel);
}

function handleSignOut() {
  auth.signOut();
  currentUser = null;
  closeChat();
  closeComments();
  clear(dom.stories);
  clear(dom.levels);
  clear(dom.feed);
  showGate('signin');
  toast('Signed out');
}

async function boot() {
  cacheDom();

  const params = new URLSearchParams(location.search);
  previewMode = params.get('preview') === '1';
  initChat({ preview: previewMode });

  // Kick off data loading immediately; the gate and the fetch race in parallel.
  dataReady = store.loadAll();
  dataReady.catch(() => {
    /* handled where it is awaited */
  });

  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'grid' || saved === 'reel') view = saved;
    const level = localStorage.getItem(LEVEL_KEY);
    if (level === 'all' || store.LEVELS.includes(level)) activeLevel = level;
  } catch {
    /* private browsing — fall back to the defaults */
  }

  dom.tabGrid.addEventListener('click', () => setView('grid'));
  dom.tabReel.addEventListener('click', () => setView('reel'));
  dom.signout.addEventListener('click', handleSignOut);
  dom.gateRetry.addEventListener('click', () => {
    auth.disableAutoSelect();
    showGate('signin');
  });

  // Preview mode: skip Google entirely so the UI can be reviewed without any config.
  if (previewMode) {
    await enterApp({ email: 'preview@bria.ai', name: 'Preview User', picture: '' });
    toast('Preview mode — sign-in and chat are disabled');
    return;
  }

  if (!isAuthConfigured()) {
    showGate(
      'not-configured',
      el('span', {}, [
        'Google sign-in isn’t configured yet. Add your OAuth client ID to ',
        el('code', {}, ['config.js']),
        ' — see SETUP.md. Append ',
        el('code', {}, ['?preview=1']),
        ' to preview the app without signing in.',
      ])
    );
    return;
  }

  const existing = auth.restoreSession();
  if (existing) {
    await enterApp(existing);
  } else {
    showGate('signin');
  }

  try {
    await auth.initGoogleSignIn(dom.gsiButton, {
      onSignedIn: (session) => {
        if (!currentUser) enterApp(session);
        else currentUser = session;
      },
      onRejected: (message) => showGate('wrong-domain', message),
    });
  } catch {
    if (!currentUser) {
      showGate('signin', 'Google Sign-In could not load. Check your connection and reload.');
    }
  }
}

boot();
