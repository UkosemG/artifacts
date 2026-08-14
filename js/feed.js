// Renders the stories row (channels) and the vertical feed of dashboard cards.

import { el, clear, formatRelativeTime, initials, displayNameFromEmail } from './ui.js';

export function renderStories(container, channels, activeId, { onSelect }) {
  clear(container);

  const all = el(
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
  );
  container.append(all);

  for (const channel of channels) {
    const ringContent = channel.emoji
      ? channel.emoji
      : el('span', { class: 'story-initials' }, [initials(channel.name)]);

    const label = channel.mine ? 'My channel' : channel.name;

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
          el('span', { class: 'story-label' }, [label]),
        ]
      )
    );
  }
}

function renderFacts(facts) {
  if (!facts || facts.length === 0) return null;

  return el(
    'dl',
    { class: 'post-facts' },
    facts.map((fact) =>
      el('div', { class: 'fact' }, [
        el('dt', {}, [fact.label]),
        el('dd', {}, [fact.value]),
      ])
    )
  );
}

function renderCard(post, channel, { onAskClaude }) {
  const metaBits = [];

  if (channel) {
    metaBits.push(
      el(
        'span',
        { class: `channel-chip${channel.type === 'personal' ? ' channel-chip--personal' : ''}` },
        [channel.emoji ? `${channel.emoji} ${channel.name}` : channel.name]
      )
    );
  }

  if (post.author) metaBits.push(el('span', {}, [displayNameFromEmail(post.author)]));

  const when = formatRelativeTime(post.publishedAt);
  if (when) metaBits.push(el('time', { datetime: post.publishedAt }, [when]));

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
    el(
      'button',
      { type: 'button', class: 'btn btn--secondary', onclick: () => onAskClaude(post) },
      ['Ask Claude']
    )
  );

  const chips =
    post.actions.length > 0
      ? el(
          'div',
          { class: 'chips' },
          post.actions.map((prompt) =>
            el(
              'button',
              {
                type: 'button',
                class: 'chip',
                onclick: () => onAskClaude(post, prompt),
              },
              [prompt]
            )
          )
        )
      : null;

  return el('article', { class: 'post-card' }, [
    metaBits.length ? el('header', { class: 'post-meta' }, metaBits) : null,
    el('h2', { class: 'post-title' }, [post.title]),
    post.description ? el('p', { class: 'post-desc' }, [post.description]) : null,
    renderFacts(post.facts),
    el('footer', { class: 'post-actions' }, actions),
    chips,
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
