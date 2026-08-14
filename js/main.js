// Boot + state machine: gate → feed → chat.

import { CONFIG, isAuthConfigured } from '../config.js';
import * as store from './store.js';
import * as auth from './auth.js';
import { initChat, openChat, closeChat } from './chat.js';
import { initComments, openComments, closeComments, primeCounts } from './comments.js';
import { renderStories, renderFeed, renderLoading, renderFeedError } from './feed.js';
import { el, clear, show, hide, initials, displayNameFromEmail, toast } from './ui.js';

const dom = {};
let currentUser = null;
let activeChannel = 'all';
let dataReady = null;
let previewMode = false;

function cacheDom() {
  dom.gate = document.getElementById('gate');
  dom.gateNote = document.getElementById('gate-note');
  dom.gateRetry = document.getElementById('gate-retry');
  dom.gsiButton = document.getElementById('gsi-button');
  dom.app = document.getElementById('app');
  dom.stories = document.getElementById('stories');
  dom.feed = document.getElementById('feed');
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

function selectChannel(channelId) {
  activeChannel = channelId;
  const channels = store.getChannels(currentUser);
  const posts = store.getPosts(activeChannel);

  renderStories(dom.stories, channels, activeChannel, { onSelect: selectChannel });
  renderFeed(dom.feed, posts, store.getChannel(activeChannel), {
    channels,
    onAskClaude: (post, prompt) => openChat(post, prompt),
    onOpenComments: (post) => openComments(post),
  });

  dom.feed.scrollTop = 0;
  primeCounts(posts);
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
