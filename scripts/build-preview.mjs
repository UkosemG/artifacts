#!/usr/bin/env node
// Bundles the app into one self-contained HTML file.
//
// The app is normally served as raw ES modules that fetch data/feed.json at
// runtime. That needs a web server, which means the only way to look at the
// design is to merge and deploy. This produces a single file that runs from
// anywhere — open it locally, or publish it as an artifact and review it on a
// phone before anything ships.
//
// It is a preview, not a build step: sign-in and chat are forced off, and the
// feed data is frozen in at build time.
//
// Usage: node scripts/build-preview.mjs [outfile]

import { readFileSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] || 'preview.html';

// Order matters: a module must be emitted after everything it imports.
const MODULES = [
  ['config', 'config.js'],
  ['ui', 'js/ui.js'],
  ['store', 'js/store.js'],
  ['auth', 'js/auth.js'],
  ['feed', 'js/feed.js'],
  ['chat', 'js/chat.js'],
  ['comments', 'js/comments.js'],
  ['main', 'js/main.js'],
];

// Strip import statements (including the multi-line form) and remember which
// names a module exports, so the bundle can hand them to whatever comes next.
function transform(src) {
  const lines = src.split('\n');
  const kept = [];
  const exported = [];
  let swallowing = false;

  for (const line of lines) {
    if (swallowing) {
      if (/\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) swallowing = false;
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      // Single-line import, or the opening of a multi-line one.
      if (!/\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) swallowing = true;
      continue;
    }

    const m = line.match(/^\s*export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/);
    if (m) exported.push(m[1]);

    kept.push(line.replace(/^(\s*)export\s+/, '$1'));
  }

  return { body: kept.join('\n'), exported };
}

const chunks = [];
for (const [name, path] of MODULES) {
  let src = readFileSync(path, 'utf8');

  if (name === 'store') {
    // No server to fetch from — the feed is frozen in below as __FEED, and
    // artifacts.json simply isn't part of a preview.
    src = src
      .replace("fetchJson('./data/feed.json')", 'Promise.resolve(__FEED)')
      .replace("fetchJson('./artifacts.json')", "Promise.reject(new Error('not in preview'))");
  }

  if (name === 'main') {
    // Preview mode unconditionally: there is no OAuth client here, and the
    // chat worker isn't reachable from a published page.
    src = src.replace(
      "previewMode = params.get('preview') === '1';",
      'previewMode = true;'
    );
  }

  const { body, exported } = transform(src);
  const ns = `__${name}`;

  chunks.push(
    `/* ── ${path} ─────────────────────────────────────────── */\n` +
      `const ${ns} = (() => {\n${body}\nreturn { ${exported.join(', ')} };\n})();\n` +
      // Destructure so later modules see the names unqualified, and keep the
      // namespace object around for `import * as store` style consumers.
      (exported.length ? `const { ${exported.join(', ')} } = ${ns};\n` : '') +
      `const ${name} = ${ns};\n`
  );
}

const feed = readFileSync('data/feed.json', 'utf8');

const css = readFileSync('style.css', 'utf8')
  // The CSP on a published artifact blocks font CDNs; drop the request rather
  // than let it fail noisily, and let the system stack take over.
  .replace(/@import\s+url\([^)]*\);?/g, '')
  .replace(':root {', ':root {\n  color-scheme: light;');

const html = readFileSync('index.html', 'utf8');
const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/);
if (!bodyMatch) {
  console.error('✖ could not find <body> in index.html');
  process.exit(1);
}
const body = bodyMatch[1].replace(/<script[^>]*src=[^>]*><\/script>/g, '');

const out = `<title>Bria Feed</title>

<style>
${css}
</style>

${body}

<script type="module">
// Built by scripts/build-preview.mjs — do not edit here, edit the app.
const __FEED = ${feed};

${chunks.join('\n')}
</script>
`;

writeFileSync(OUT, out);
const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`✓ ${OUT} — ${kb}KB, ${MODULES.length} modules inlined, preview mode forced on.`);
