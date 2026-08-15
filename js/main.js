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

const LEVEL_KEY = 'briafeed.level.v1';

const dom = {};
let currentUser = null;
let activeChannel = 'all';
let dataReady = null;
let previewMode = false;
// The grid is the app. 'post' is the tap-through detail — the reel rendering,
// entered from a tile and left with the back bar.
let mode = 'grid';
// Where the grid was scrolled to when a post was opened, so back returns there.
let gridScroll = null;
let openPostId = null;
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
  dom.postNav = document.getElementById('post-nav');
  dom.postBack = document.getElementById('post-back');
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

function renderCurrentView({ scrollToPostId, restoreScroll } = {}) {
  const channels = store.getChannels(currentUser);
  const posts = store.getPosts(activeChannel, activeLevel, currentUser);
  const channel = store.getChannel(activeChannel);
  const isGrid = mode === 'grid';

  renderStories(dom.stories, channels, activeChannel, { onSelect: selectChannel });
  renderLevels(dom.levels, store.countByLevel(activeChannel, currentUser), activeLevel, {
    onSelect: selectLevel,
  });

  // Class toggle must precede the scroll work below: .feed--grid disables the
  // reel's scroll snapping, and a restored scrollTop set while snapping is
  // still active would be re-quantized to the nearest card.
  dom.feed.classList.toggle('feed--grid', isGrid);
  dom.feed.classList.toggle('feed--reel', !isGrid);
  dom.postNav.hidden = isGrid;

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
    // Focus lands on the card first (preventScroll, so scrollIntoView stays
    // authoritative) — a screen reader announces the post, and the back bar is
    // the immediately preceding tab stop.
    if (card) {
      requestAnimationFrame(() => {
        card.setAttribute('tabindex', '-1');
        card.focus({ preventScroll: true });
        card.scrollIntoView({ block: 'start' });
      });
    }
  } else if (restoreScroll) {
    // Mobile scrolls #feed; desktop scrolls the page. The inactive one is 0.
    requestAnimationFrame(() => {
      dom.feed.scrollTop = restoreScroll.feedTop;
      window.scrollTo(0, restoreScroll.winY);
    });
  } else {
    dom.feed.scrollTop = 0;
  }

  // Comment counts only exist on reel cards, so don't fetch them for a grid.
  if (!isGrid) primeCounts(posts);
}

function selectChannel(channelId) {
  // Filters are browse tools: changing one while reading a post drops back to
  // the grid — a saved scroll offset is meaningless against a different set.
  mode = 'grid';
  gridScroll = null;
  activeChannel = channelId;
  renderCurrentView();
}

function selectLevel(level) {
  mode = 'grid';
  gridScroll = null;
  activeLevel = level;
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch {
    /* private browsing — the choice just won't survive a reload */
  }
  renderCurrentView();
}

// Tapping a tile is how you get from the index to the post.
function openPost(post) {
  gridScroll = { feedTop: dom.feed.scrollTop, winY: window.scrollY };
  openPostId = post.id;
  mode = 'post';
  renderCurrentView({ scrollToPostId: post.id });
}

function closePost() {
  if (mode !== 'post') return;
  mode = 'grid';
  renderCurrentView({ restoreScroll: gridScroll });
  // Focus returns to the tile that opened the post, like closing a dialog.
  const id = openPostId;
  requestAnimationFrame(() => {
    const tile = id && dom.feed.querySelector(`[data-tile-for="${CSS.escape(id)}"]`);
    if (tile) tile.focus({ preventScroll: true });
  });
  gridScroll = null;
  openPostId = null;
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
  mode = 'grid';
  gridScroll = null;
  openPostId = null;
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
    const level = localStorage.getItem(LEVEL_KEY);
    if (level === 'all' || store.LEVELS.includes(level)) activeLevel = level;
    // The old grid/reel preference is gone; clean up the orphaned key.
    localStorage.removeItem('briafeed.view.v1');
  } catch {
    /* private browsing — fall back to the defaults */
  }

  dom.postBack.addEventListener('click', closePost);
  // Escape leaves the post view — but chat and comments register their own
  // document-level Escape closers, and one press must not close two layers.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || mode !== 'post') return;
    const chatOpen = !document.getElementById('chat-panel')?.hidden;
    const commentsOpen = !document.getElementById('comments-sheet')?.hidden;
    if (!chatOpen && !commentsOpen) closePost();
  });
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
