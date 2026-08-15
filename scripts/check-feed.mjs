#!/usr/bin/env node
// Validates data/feed.json before it ships.
//
// Two jobs. The first is ordinary shape checking — duplicate ids, posts pointing
// at channels that don't exist, artifact links that aren't https.
//
// The second matters more: this repository is PUBLIC, so every string in a card
// is world-readable. Bria's revenue figures, targets, pipeline and customer
// names are confidential and belong in the Claude artifact, where access is
// actually controlled. A comment in feed.json asking people to remember that is
// not a control; this is. It runs in CI on every push.
//
// Note on scope: this checks for money-shaped strings and finance vocabulary,
// which are generic patterns that leak nothing by being written here. It cannot
// check for confidential customer names — a denylist of those would itself be a
// leak, sitting in the same public repo. That one stays a human rule.
//
// Usage: node scripts/check-feed.mjs

import { readFileSync } from 'node:fs';

// Path is overridable so the checks can be exercised against fixtures.
const FEED = process.argv[2] || 'data/feed.json';

// Fields whose contents are rendered onto a card, and so are public.
const CARD_TEXT_FIELDS = ['title', 'description', 'source'];

// Always a leak, whatever the surrounding words.
const MONEY_PATTERNS = [
  [/[$€£]\s?\d/, 'a currency amount'],
  [/\b\d+(?:\.\d+)?\s?[MK]\b/, 'an abbreviated amount like "4M" or "250K"'],
  [/\b\d[\d,]*\.\d{2}\b/, 'a decimal amount'],
  [/\b\d{1,3}(?:,\d{3})+\b/, 'a comma-grouped figure'],
];

// Finance vocabulary is only a problem when it is carrying a quantity. "A
// forecast of H2" describes what a post is and leaks nothing; "forecast: 25% of
// target" is the thing to stop. So a term alone never fails — a term sharing a
// string with a quantity does.
//
// Matched with word boundaries, because otherwise "carry" contains "arr".
const FINANCE_TERMS = [
  'arr', 'mrr', 'acv', 'nrr',
  'bookings', 'booked', 'pipeline', 'revenue', 'quota', 'forecast',
  'target', 'coverage', 'attainment', 'churn', 'renewal', 'win rate', 'deal size',
];

// A quantity worth protecting: money, a percentage, an abbreviated amount, or a
// number big enough to be a real figure. Deliberately excludes small numbers, so
// "H2" and "29 August" stay usable.
const QUANTITY = /[$€£]\s?\d|\d+(?:\.\d+)?\s?%|\b\d{3,}\b|\b\d+(?:\.\d+)?\s?[MK]\b/;

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}

// ---------- load ----------

let feed;
try {
  feed = JSON.parse(readFileSync(FEED, 'utf8'));
} catch (err) {
  console.error(`✖ ${FEED} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const channels = Array.isArray(feed.channels) ? feed.channels : [];
const posts = Array.isArray(feed.posts) ? feed.posts : [];

if (channels.length === 0) fail('no channels defined');
if (posts.length === 0) warnings.push('no posts defined — the feed will render empty');

// ---------- shape ----------

const channelIds = new Set();
for (const [i, c] of channels.entries()) {
  const where = `channels[${i}]`;
  if (!c || typeof c !== 'object') { fail(`${where} is not an object`); continue; }
  if (!c.id) fail(`${where} has no id`);
  else if (channelIds.has(c.id)) fail(`${where} duplicates channel id "${c.id}"`);
  else channelIds.add(c.id);
  if (!c.name) fail(`${where} ("${c.id}") has no name`);
  if (c.type && !['org', 'bu', 'personal'].includes(c.type)) {
    fail(`${where} ("${c.id}") has unknown type "${c.type}"`);
  }
  if (c.type === 'personal' && !c.owner) {
    fail(`${where} ("${c.id}") is personal but has no owner email`);
  }
}

const postIds = new Set();
for (const [i, p] of posts.entries()) {
  const where = `posts[${i}]`;
  if (!p || typeof p !== 'object') { fail(`${where} is not an object`); continue; }

  const label = p.id || p.title || `#${i}`;
  if (!p.id) fail(`${where} has no id`);
  else if (postIds.has(p.id)) fail(`${where} duplicates post id "${p.id}"`);
  else postIds.add(p.id);

  if (!p.title) fail(`${where} ("${label}") has no title`);
  if (p.channel && !channelIds.has(p.channel)) {
    fail(`${where} ("${label}") points at unknown channel "${p.channel}"`);
  }
  if (p.artifactUrl && !/^https:\/\//.test(p.artifactUrl)) {
    fail(`${where} ("${label}") artifactUrl is not https`);
  }
  if (p.publishedAt && Number.isNaN(Date.parse(p.publishedAt))) {
    fail(`${where} ("${label}") publishedAt is not a parseable date`);
  } else if (p.publishedAt && Date.parse(p.publishedAt) > Date.now()) {
    // The card renders a relative time, so a future stamp reads as
    // "in 5 hours" — a post that appears to be published later than now.
    fail(`${where} ("${label}") publishedAt is in the future — the card will read "in N hours"`);
  }

  const level = p.level;
  if (level && !['company', 'function', 'team', 'me'].includes(level)) {
    fail(`${where} ("${label}") has unknown level "${level}"`);
  }
  if (level === 'me' && !p.owner) {
    warnings.push(`"${label}" is at "me" level with no owner — it will show for everyone`);
  }

  // The grid tile leads with the first fact, so a post without one falls back
  // to its title. Worth knowing about, not worth failing over.
  if (!Array.isArray(p.facts) || p.facts.length === 0) {
    warnings.push(`"${label}" has no facts — its tile will show the title instead`);
  }

  // House rule: a number without a target and a date is not allowed. Any post
  // that shows figures must say where the figure has to get to, and by when.
  const showsNumbers = (Array.isArray(p.facts) && p.facts.length > 0) || p.chart;
  if (showsNumbers) {
    const t = p.target;
    if (!t || typeof t !== 'object' || !String(t.value || '').trim() || !String(t.by || '').trim()) {
      fail(
        `${where} ("${label}") shows figures but has no target — every number needs ` +
          `a target {value, by}. A number without a destination is decoration.`
      );
    }
  }

  // A task must be executable: owner, deadline, and dated milestones.
  if (p.task != null) {
    const t = p.task;
    const bad = (msg) => fail(`${where} ("${label}") task ${msg}`);
    if (!t || typeof t !== 'object') bad('is not an object');
    else {
      if (!String(t.owner || '').trim()) bad('has no owner — use "TBN" to make the gap visible, not blank');
      if (!String(t.due || '').trim()) bad('has no due date');
      const ms = Array.isArray(t.milestones) ? t.milestones : [];
      if (ms.length === 0) bad('has no milestones — a deadline with no path to it is a wish');
      for (const [j, m] of ms.entries()) {
        if (!m || !String(m.what || '').trim()) bad(`milestone[${j}] has no "what"`);
        if (!m || Number.isNaN(Date.parse(m.due))) bad(`milestone[${j}] due is not a parseable date`);
      }
    }
  }
}

// ---------- public-repo scan ----------

// Every string a reader can see on the card, flattened with a path for the error.
function cardStrings(post) {
  const out = [];
  for (const f of CARD_TEXT_FIELDS) {
    if (typeof post[f] === 'string') out.push([f, post[f]]);
  }
  for (const [i, fact] of (post.facts || []).entries()) {
    if (fact && typeof fact === 'object') {
      out.push([`facts[${i}].label`, String(fact.label ?? '')]);
      out.push([`facts[${i}].value`, String(fact.value ?? '')]);
    }
  }
  for (const [i, a] of (post.actions || []).entries()) {
    if (typeof a === 'string') out.push([`actions[${i}]`, a]);
  }
  const chart = post.chart;
  if (chart && typeof chart === 'object') {
    if (chart.label) out.push(['chart.label', String(chart.label)]);
    for (const [i, s] of (chart.segments || []).entries()) {
      if (s && s.label) out.push([`chart.segments[${i}].label`, String(s.label)]);
    }
  }
  return out;
}

for (const post of posts) {
  const label = post.id || post.title || 'post';
  for (const [path, text] of cardStrings(post)) {
    for (const [pattern, what] of MONEY_PATTERNS) {
      const m = text.match(pattern);
      if (m) {
        fail(
          `"${label}" ${path} contains ${what} ("${m[0]}"). ` +
            `This repo is public — put figures in the linked artifact, not on the card.`
        );
      }
    }
    if (QUANTITY.test(text)) {
      for (const term of FINANCE_TERMS) {
        if (new RegExp(`\\b${term}\\b`, 'i').test(text)) {
          fail(
            `"${label}" ${path} pairs "${term}" with a figure — "${text}". ` +
              `This repo is public — keep financial detail in the linked artifact.`
          );
        }
      }
    }
  }
}

// ---------- report ----------

for (const w of warnings) console.warn(`⚠ ${w}`);

if (errors.length > 0) {
  for (const e of errors) console.error(`✖ ${e}`);
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} in ${FEED}.`);
  process.exit(1);
}

console.log(
  `✓ ${FEED} — ${channels.length} channels, ${posts.length} posts, no figures on cards.`
);
