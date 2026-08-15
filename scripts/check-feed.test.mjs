#!/usr/bin/env node
// Proves check-feed.mjs actually catches things.
//
// Without this, the checker can be quietly loosened — a regex edited, a term
// dropped — and nothing would notice until a revenue figure was already sitting
// on a public page. Each case below mutates a copy of the real feed into
// something that must be rejected, and asserts the checker rejects it.
//
// Usage: node scripts/check-feed.test.mjs

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECKER = 'scripts/check-feed.mjs';
const base = JSON.parse(readFileSync('data/feed.json', 'utf8'));

const clone = () => JSON.parse(JSON.stringify(base));

const cases = [
  ['currency on a card', (f) => f.posts[0].facts.unshift({ label: 'Booked', value: '$2,401' })],
  ['abbreviated amount', (f) => f.posts[0].facts.unshift({ label: 'Target', value: '9M' })],
  ['decimal amount', (f) => (f.posts[0].source = 'Renewals 500804.04 closed')],
  ['comma-grouped figure', (f) => (f.posts[0].source = 'Core pipeline 6,047,585')],
  ['finance term with a percentage', (f) => (f.posts[0].description = 'Coverage is 67% of what we need.')],
  ['finance term in a chip', (f) => f.posts[0].actions.push('What is the revenue forecast for 1200 seats?')],
  ['figure in a chart label', (f) => (f.posts[1].chart.label = 'Bookings against the 9M target')],
  ['duplicate post id', (f) => f.posts.push(clone().posts[0])],
  ['unknown channel', (f) => (f.posts[0].channel = 'nope')],
  ['non-https artifact url', (f) => (f.posts[0].artifactUrl = 'http://example.com/x')],
  ['unparseable publishedAt', (f) => (f.posts[0].publishedAt = 'last tuesday')],
  ['future publishedAt', (f) => (f.posts[0].publishedAt = '2099-01-01T00:00:00Z')],
  ['unknown level', (f) => (f.posts[0].level = 'galaxy')],
  ['post with no title', (f) => delete f.posts[0].title],
  ['personal channel with no owner', (f) => delete f.channels.find((c) => c.type === 'personal').owner],
  ['duplicate channel id', (f) => f.channels.push({ ...f.channels[0] })],
];

const dir = mkdtempSync(join(tmpdir(), 'feedcheck-'));
let failures = 0;

function run(path) {
  return spawnSync('node', [CHECKER, path], { encoding: 'utf8' });
}

// The real feed must pass, or every rejection below proves nothing.
{
  const ok = run('data/feed.json');
  if (ok.status !== 0) {
    console.error('✖ data/feed.json does not pass its own checker:\n' + ok.stderr);
    failures += 1;
  } else {
    console.log('✓ the committed feed passes');
  }
}

for (const [name, mutate] of cases) {
  const feed = clone();
  mutate(feed);
  const path = join(dir, `${name.replace(/\W+/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(feed));

  const res = run(path);
  if (res.status === 0) {
    console.error(`✖ NOT CAUGHT: ${name}`);
    failures += 1;
  } else {
    console.log(`✓ caught: ${name}`);
  }
}

// Malformed JSON is its own failure mode.
{
  const path = join(dir, 'broken.json');
  writeFileSync(path, '{ not json');
  if (run(path).status === 0) {
    console.error('✖ NOT CAUGHT: malformed JSON');
    failures += 1;
  } else {
    console.log('✓ caught: malformed JSON');
  }
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) did not behave as expected.`);
  process.exit(1);
}
console.log(`\n${cases.length + 2} checks passed.`);
