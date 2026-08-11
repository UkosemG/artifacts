function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

async function load() {
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');

  let artifacts = [];
  try {
    const res = await fetch('./artifacts.json', { cache: 'no-store' });
    artifacts = await res.json();
  } catch {
    artifacts = [];
  }

  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  listEl.innerHTML = artifacts
    .map(
      (a) => `
    <a class="artifact-card" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">
      <p class="artifact-card-title">${escapeHtml(a.title)} <span class="arrow">&rarr;</span></p>
      ${a.description ? `<p class="artifact-card-desc">${escapeHtml(a.description)}</p>` : ''}
      <div class="artifact-card-date">${formatDate(a.addedAt)}</div>
    </a>`
    )
    .join('');
}

load();
