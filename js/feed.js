// Renders the stories row (channels) and the feed of dashboard posts.
//
// A post follows Instagram's anatomy: header (who posted), then the "media" —
// here the dashboard's headline figures — then the action row, then the caption,
// then comments. The figures are the picture; everything else sits under it.

import { el, clear, formatRelativeTime, initials, displayNameFromEmail } from './ui.js';

export function renderStories(container, channels, activeId, { onSelect }) {
  clear(container);

  container.append(
    el(
      'button',
      {
        type: 'button',
        class: 'story',
        'aria-pressed': String(activeId === 'all'),
        onclick: () => onSelect('all'),
      },
      [
        el('span', { class: 'story-ring', 'aria-hidden': 'true' }, ['✨']),
        el('span', { class: 'story-label' }, ['All']),
      ]
    )
  );

  for (const channel of channels) {
    const ringContent = channel.emoji
      ? channel.emoji
      : el('span', { class: 'story-initials' }, [initials(channel.name)]);

    container.append(
      el(
        'button',
        {
          type: 'button',
          class: `story${channel.mine ? ' story--mine' : ''}`,
          'aria-pressed': String(activeId === channel.id),
          title: channel.description || channel.name,
          onclick: () => onSelect(channel.id),
        },
        [
          el('span', { class: 'story-ring', 'aria-hidden': 'true' }, [ringContent]),
          el('span', { class: 'story-label' }, [channel.mine ? 'My channel' : channel.name]),
        ]
      )
    );
  }
}

// The headline figures, presented as the post's image.
function renderMedia(post) {
  const facts = post.facts || [];

  if (facts.length === 0) {
    return el('div', { class: 'post-media post-media--bare' }, [
      el('p', { class: 'post-media-empty' }, ['Open the dashboard for the detail.']),
    ]);
  }

  return el('div', { class: `post-media post-media--${Math.min(facts.length, 4)}` }, [
    el(
      'dl',
      { class: 'post-facts' },
      facts.map((fact) =>
        el('div', { class: 'fact' }, [
          el('dt', {}, [fact.label]),
          el('dd', {}, [fact.value]),
        ])
      )
    ),
  ]);
}

function renderCard(post, channel, handlers) {
  const { onAskClaude, onOpenComments } = handlers;

  const avatar = channel?.emoji
    ? el('span', { class: 'post-avatar', 'aria-hidden': 'true' }, [channel.emoji])
    : el('span', { class: 'post-avatar', 'aria-hidden': 'true' }, [initials(post.title)]);

  const subParts = [channel ? channel.name : 'Bria'];
  if (post.author) subParts.push(displayNameFromEmail(post.author));
  const when = formatRelativeTime(post.publishedAt);
  if (when) subParts.push(when);

  const head = el('header', { class: 'post-head' }, [
    avatar,
    el('div', { class: 'post-head-text' }, [
      el('h2', { class: 'post-title' }, [post.title]),
      el('p', { class: 'post-sub' }, [subParts.join(' · ')]),
    ]),
  ]);

  const actions = [];
  if (post.artifactUrl) {
    actions.push(
      el(
        'a',
        {
          class: 'btn btn--primary',
          href: post.artifactUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        ['Open dashboard ↗']
      )
    );
  }
  actions.push(
    el('button', { type: 'button', class: 'btn btn--secondary', onclick: () => onAskClaude(post) }, [
      'Ask Claude',
    ])
  );

  const chips =
    post.actions.length > 0
      ? el(
          'div',
          { class: 'chips' },
          post.actions.map((prompt) =>
            el('button', { type: 'button', class: 'chip', onclick: () => onAskClaude(post, prompt) }, [
              prompt,
            ])
          )
        )
      : null;

  // Caption: the description, under the post, the way a caption sits under a photo.
  const caption = post.description
    ? el('div', { class: 'post-caption' }, [el('p', {}, [post.description])])
    : null;

  // Comment count is filled in by comments.js once the thread loads.
  const commentLine = el(
    'button',
    {
      type: 'button',
      class: 'comment-line',
      dataset: { commentCountFor: post.id },
      onclick: () => onOpenComments(post),
    },
    ['Add a comment…']
  );

  return el('article', { class: 'post-card', dataset: { postId: post.id } }, [
    head,
    renderMedia(post),
    el('footer', { class: 'post-actions' }, actions),
    chips,
    caption,
    el('div', { class: 'post-comments' }, [commentLine]),
  ]);
}

export function renderFeed(container, posts, channel, handlers) {
  clear(container);
  container.setAttribute('aria-busy', 'false');

  if (channel && channel.description) {
    container.append(el('p', { class: 'channel-intro' }, [channel.description]));
  }

  if (posts.length === 0) {
    container.append(
      el('div', { class: 'empty' }, [
        el('p', {}, [
          channel && channel.mine
            ? 'Nothing in your channel yet. Ask Claude to publish a dashboard here.'
            : 'Nothing posted here yet.',
        ]),
      ])
    );
    return;
  }

  const byId = new Map();
  if (handlers.channels) for (const c of handlers.channels) byId.set(c.id, c);

  for (const post of posts) {
    container.append(renderCard(post, byId.get(post.channel), handlers));
  }
}

export function renderLoading(container) {
  clear(container);
  container.setAttribute('aria-busy', 'true');
  for (let i = 0; i < 3; i += 1) {
    container.append(el('div', { class: 'skeleton', 'aria-hidden': 'true' }));
  }
}

export function renderFeedError(container, message) {
  clear(container);
  container.setAttribute('aria-busy', 'false');
  container.append(
    el('div', { class: 'feed-error' }, [
      el('p', {}, [message || 'Feed unavailable.']),
      el('p', {}, ['Check that data/feed.json is present and valid, then reload.']),
    ])
  );
}
