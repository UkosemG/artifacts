// Renders the stories row (channels) and the feed of dashboard posts.
//
// A post follows Instagram's anatomy: header (who posted), then the "media" —
// here the dashboard's headline figures — then the action row, then the caption,
// then comments. The figures are the picture; everything else sits under it.

import { el, clear, formatRelativeTime, initials, displayNameFromEmail } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// A sparkline: one series, so no legend — the label above names it. The last point
// is called out because it's the number the hero figure is about. Reading a value
// off it is the dashboard's job, one tap away; this is the shape at a glance.
function renderLineChart(chart) {
  const values = (chart.values || []).filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;

  const W = 300;
  const H = 64;
  const pad = 4;
  const max = Math.max(...values, 1);
  const stepX = (W - pad * 2) / (values.length - 1);
  const y = (v) => pad + (H - pad * 2) * (1 - v / max);
  const x = (i) => pad + stepX * i;

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const solid = chart.partialLast ? points.slice(0, -1) : points;

  const frame = svg('svg', {
    class: 'spark',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `${chart.label}, ${chart.from} to ${chart.to}. ${values.length} values, from ${values[0]} to ${values[values.length - 1]}, peaking at ${max}.`,
  });

  frame.append(
    svg('path', {
      class: 'spark-fill',
      d: `M ${x(0)},${H - pad} L ${solid.join(' L ')} L ${x(solid.length - 1)},${H - pad} Z`,
    }),
    svg('path', { class: 'spark-line', d: `M ${solid.join(' L ')}` })
  );

  // The in-progress day is dashed, matching how the dashboard itself marks it.
  if (chart.partialLast && points.length > 1) {
    frame.append(
      svg('path', {
        class: 'spark-line spark-line--partial',
        d: `M ${points[points.length - 2]} L ${points[points.length - 1]}`,
      })
    );
  }

  const lastIndex = values.length - 1;
  frame.append(
    svg('circle', { class: 'spark-dot', cx: x(lastIndex), cy: y(values[lastIndex]), r: 3.5 })
  );

  return el('figure', { class: 'chart' }, [
    el('figcaption', { class: 'chart-label' }, [
      chart.label,
      el('span', { class: 'chart-range' }, [`${chart.from} – ${chart.to}`]),
    ]),
    frame,
  ]);
}

// A part-to-whole bar. Segments are direct-labelled, so identity never rests on
// colour alone — which is also what keeps the tones legible to colourblind readers.
function renderProportionChart(chart) {
  const segments = (chart.segments || []).filter((s) => Number.isFinite(s.value) && s.value > 0);
  if (segments.length === 0) return null;

  const total = segments.reduce((sum, s) => sum + s.value, 0);

  return el('figure', { class: 'chart' }, [
    el('figcaption', { class: 'chart-label' }, [chart.label]),
    el(
      'div',
      { class: 'proportion', role: 'img', 'aria-label': segments.map((s) => `${s.label} ${s.value} of ${total}`).join(', ') },
      segments.map((s) =>
        el('span', {
          class: `proportion-seg proportion-seg--${s.tone}`,
          style: `flex-grow:${s.value}`,
          title: `${s.label}: ${s.value} of ${total}`,
        })
      )
    ),
    el(
      'ul',
      { class: 'proportion-key' },
      segments.map((s) =>
        el('li', {}, [
          el('span', { class: `key-dot key-dot--${s.tone}`, 'aria-hidden': 'true' }),
          `${s.label} ${s.value}`,
        ])
      )
    ),
  ]);
}

function renderChart(post) {
  const chart = post.chart;
  if (!chart) return null;
  if (chart.type === 'line') return renderLineChart(chart);
  if (chart.type === 'proportion') return renderProportionChart(chart);
  return null;
}

// The altitude a post speaks at, shortest label that still reads.
const LEVEL_LABELS = {
  all: 'All levels',
  company: 'Company',
  function: 'Function',
  team: 'Team',
  me: 'Me',
};

const LEVEL_ORDER = ['all', 'company', 'function', 'team', 'me'];

export function levelLabel(level) {
  return LEVEL_LABELS[level] || level;
}

// A second filter beside the channel row. Channel is the subject; level is how
// far down it reaches. An engineer filtering to "Me" should be left with the
// handful of things that are actually theirs to do.
export function renderLevels(container, counts, activeLevel, { onSelect }) {
  clear(container);

  for (const level of LEVEL_ORDER) {
    const count = counts[level] || 0;
    const empty = level !== 'all' && count === 0;

    container.append(
      el(
        'button',
        {
          type: 'button',
          class: `level-chip${empty ? ' level-chip--empty' : ''}`,
          'aria-pressed': String(activeLevel === level),
          // Disabled would drop it from the tab order and hide the zero, which
          // is itself information: nothing has been published at this altitude.
          title: empty ? `Nothing published at ${LEVEL_LABELS[level]} level yet` : undefined,
          onclick: () => onSelect(level),
        },
        [
          LEVEL_LABELS[level],
          el('span', { class: 'level-count' }, [String(count)]),
        ]
      )
    );
  }
}

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

// The headline figures, presented as the post's image. The first fact leads at
// display size — a phone screen should answer "how are we doing" from across the
// room — and the rest sit under it as supporting numbers.
function renderMedia(post) {
  const facts = post.facts || [];

  if (facts.length === 0) {
    return el('div', { class: 'post-media post-media--bare' }, [
      el('p', { class: 'post-media-empty' }, ['Open the dashboard for the detail.']),
    ]);
  }

  const [hero, ...rest] = facts;

  return el('div', { class: 'post-media' }, [
    el('div', { class: 'hero-fact' }, [
      el('p', { class: 'hero-label' }, [hero.label]),
      el('p', { class: 'hero-value' }, [hero.value]),
    ]),
    renderChart(post),
    rest.length
      ? el(
          'dl',
          { class: `post-facts post-facts--${rest.length}` },
          rest.map((fact) =>
            el('div', { class: 'fact' }, [
              el('dt', {}, [fact.label]),
              el('dd', {}, [fact.value]),
            ])
          )
        )
      : null,
    post.source ? el('p', { class: 'post-source' }, [post.source]) : null,
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
    el('span', { class: `level-badge level-badge--${post.level}` }, [LEVEL_LABELS[post.level]]),
  ]);

  const actions = [];
  if (post.artifactUrl) {
    // Dashboards live on claude.ai; anything else is original content — a blog
    // post, a LinkedIn post — and the button should say where the tap goes.
    const isDashboard = post.artifactUrl.includes('claude.ai');
    actions.push(
      el(
        'a',
        {
          class: 'btn btn--primary',
          href: post.artifactUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        [isDashboard ? 'Open dashboard ↗' : 'Open post ↗']
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

// ---------- Grid view ----------
//
// Instagram's profile grid, where the photo is the number. A tile carries the
// post's first fact and nothing else — at three across it is ~118px wide, which
// fits a figure or a chart but not both. The chart is why you tap through.

// A wall of white tiles reads as a spreadsheet; Instagram's grid gets its rhythm
// from photos, and channel colour is what stands in for that here. Named channels
// keep a fixed tint so the grid looks the same on every visit; anything new cycles
// through the same six.
const TINT_BY_CHANNEL = { org: 1, create: 2, rnd: 3, gtm: 4, marketing: 5 };
const TINT_COUNT = 6;

function tintIndex(channel, order) {
  if (channel && TINT_BY_CHANNEL[channel.id]) return TINT_BY_CHANNEL[channel.id];
  if (channel && channel.type === 'personal') return 6;
  return ((order || 0) % TINT_COUNT) + 1;
}

function renderTile(post, channel, onOpenPost) {
  const hero = (post.facts || [])[0];
  const tint = tintIndex(channel, channel ? channel.order : 0);

  // Title always renders: a bare number on a tint doesn't say what it measures.
  const head = el('span', { class: 'tile-head' }, [
    channel && channel.emoji
      ? el('span', { class: 'tile-mark', 'aria-hidden': 'true' }, [channel.emoji])
      : null,
    el('span', { class: 'tile-title' }, [post.title]),
    el('span', { class: `tile-level tile-level--${post.level}` }, [LEVEL_LABELS[post.level]]),
  ]);

  const inner = [head];

  if (hero) {
    // Long values step down a size — "29 Aug" set at "138"'s size overwhelms the row.
    const long = String(hero.value).length > 4;
    inner.push(
      el('span', { class: 'tile-hero' }, [
        el('span', { class: `tile-val${long ? ' tile-val--sm' : ''}` }, [hero.value]),
        el('span', { class: 'tile-lab' }, [hero.label]),
      ])
    );
  }

  // Full-width tiles have room for the same chart the card shows.
  const chart = renderChart(post);
  if (chart) inner.push(chart);

  return el(
    'button',
    {
      type: 'button',
      class: `tile tile--t${tint}`,
      dataset: { tileFor: post.id },
      'aria-label': hero
        ? `${post.title}. ${hero.label}: ${hero.value}`
        : post.title,
      onclick: () => onOpenPost(post),
    },
    inner
  );
}

export function renderGrid(container, posts, channel, handlers) {
  clear(container);
  container.setAttribute('aria-busy', 'false');

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

  // Channel order drives the fallback tint, so keep each channel's position.
  const byId = new Map();
  if (handlers.channels) {
    handlers.channels.forEach((c, i) => byId.set(c.id, { ...c, order: i }));
  }

  container.append(
    el(
      'div',
      { class: 'tile-grid' },
      posts.map((post) => renderTile(post, byId.get(post.channel), handlers.onOpenPost))
    )
  );
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
