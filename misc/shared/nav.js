// Burger menu shared by every misc/*-ui page.
//
// Each page includes it with a single line, near the end of <body>:
//
//   <script type="module" src="../shared/nav.js"></script>
//
// The pages have wildly different CSS — three are dark-only, one is
// theme-aware, one is Bootstrap — so the menu lives in a shadow root with its
// own styles, and picks a light or dark skin by measuring the page's own
// background. Nothing here leaks into the page, and no page rule reaches in.

import { PAGES } from './pages.mjs';

// The pages link to each other as `../<slug>/`, which is what serve.mjs maps
// onto `<slug>-ui/`. Opening a file directly still has to go through the real
// directory name, so resolve against how this page was actually loaded.
function hrefFor(slug) {
  if (location.protocol === 'file:') return `../${slug}-ui/index.html`;
  const segments = location.pathname.split('/').filter(Boolean);
  const dir = segments[segments.length - 2] ?? segments[segments.length - 1];
  return dir?.endsWith('-ui') ? `../${slug}-ui/` : `../${slug}/`;
}

function currentSlug() {
  const segments = location.pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const name = segments[i].replace(/-ui$/, '');
    if (PAGES.some((page) => page.slug === name)) return name;
  }
  return null;
}

// Three of the five pages hard-code a dark palette and ignore
// prefers-color-scheme, so asking the media query would get it wrong on them.
// The rendered background is the honest answer.
function pageIsDark() {
  for (const node of [document.body, document.documentElement]) {
    const color = getComputedStyle(node).backgroundColor;
    const parts = color.match(/[\d.]+/g)?.map(Number);
    if (!parts || parts.length < 3) continue;
    if (parts.length > 3 && parts[3] === 0) continue; // transparent, keep looking
    const [r, g, b] = parts;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  }
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

const CSS = `
  :host {
    --nav-surface: #ffffff;
    --nav-surface-hover: #f1f4f6;
    --nav-line: #d7dee2;
    --nav-ink: #161c1f;
    --nav-ink-dim: #5d6b70;
    --nav-accent: #0b6e7a;
    --nav-shadow: 0 6px 24px rgba(9, 20, 24, 0.18);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      Helvetica, Arial, sans-serif;
  }

  :host([data-skin='dark']) {
    --nav-surface: #171a21;
    --nav-surface-hover: #212632;
    --nav-line: #2f3542;
    --nav-ink: #e4e6eb;
    --nav-ink-dim: #9aa0ad;
    --nav-accent: #7aa5ff;
    --nav-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
  }

  .wrap {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 2147483000;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }

  button.toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 1px solid var(--nav-line);
    border-radius: 6px;
    background: var(--nav-surface);
    color: var(--nav-ink);
    box-shadow: var(--nav-shadow);
    cursor: pointer;
    transition: background-color 160ms ease;
  }

  button.toggle:hover { background: var(--nav-surface-hover); }
  button.toggle:focus-visible {
    outline: 2px solid var(--nav-accent);
    outline-offset: 2px;
  }

  .bars { display: block; width: 18px; height: 14px; position: relative; }
  .bars i {
    position: absolute;
    left: 0;
    width: 100%;
    height: 2px;
    border-radius: 2px;
    background: currentColor;
    transition: transform 160ms ease, opacity 120ms ease;
  }
  .bars i:nth-child(1) { top: 0; }
  .bars i:nth-child(2) { top: 6px; }
  .bars i:nth-child(3) { top: 12px; }

  button.toggle[aria-expanded='true'] .bars i:nth-child(1) {
    transform: translateY(6px) rotate(45deg);
  }
  button.toggle[aria-expanded='true'] .bars i:nth-child(2) { opacity: 0; }
  button.toggle[aria-expanded='true'] .bars i:nth-child(3) {
    transform: translateY(-6px) rotate(-45deg);
  }

  nav {
    width: min(320px, calc(100vw - 24px));
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--nav-line);
    border-radius: 8px;
    background: var(--nav-surface);
    box-shadow: var(--nav-shadow);
  }

  nav[hidden] { display: none; }

  p.heading {
    margin: 6px 8px 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--nav-ink-dim);
  }

  a {
    display: block;
    padding: 9px 10px;
    border-radius: 6px;
    color: var(--nav-ink);
    text-decoration: none;
    border-left: 2px solid transparent;
  }

  a:hover { background: var(--nav-surface-hover); }
  a:focus-visible {
    outline: 2px solid var(--nav-accent);
    outline-offset: -2px;
  }
  a[aria-current='page'] {
    border-left-color: var(--nav-accent);
    background: var(--nav-surface-hover);
  }

  a .title { display: block; font-size: 14px; font-weight: 600; }
  a .blurb {
    display: block;
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--nav-ink-dim);
  }

  hr {
    margin: 6px 8px;
    border: 0;
    border-top: 1px solid var(--nav-line);
  }

  @media print { .wrap { display: none; } }

  @media (prefers-reduced-motion: reduce) {
    button.toggle, .bars i { transition: none; }
  }
`;

function build() {
  const host = document.createElement('div');
  host.id = 'misc-nav';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Open page menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'misc-nav-panel');
  toggle.innerHTML = '<span class="bars"><i></i><i></i><i></i></span>';

  const panel = document.createElement('nav');
  panel.id = 'misc-nav-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'TestSummary tools');

  const heading = document.createElement('p');
  heading.className = 'heading';
  heading.textContent = 'TestSummary tools';
  panel.appendChild(heading);

  const active = currentSlug();
  for (const page of PAGES) {
    const link = document.createElement('a');
    if (page.slug === active) {
      link.href = location.pathname + location.search + location.hash;
      link.setAttribute('aria-current', 'page');
    } else {
      link.href = hrefFor(page.slug);
    }
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = page.title;
    const blurb = document.createElement('span');
    blurb.className = 'blurb';
    blurb.textContent = page.blurb;
    link.append(title, blurb);
    panel.appendChild(link);
  }

  panel.appendChild(document.createElement('hr'));
  const index = document.createElement('a');
  index.href = '../';
  const indexTitle = document.createElement('span');
  indexTitle.className = 'title';
  indexTitle.textContent = 'All pages';
  const indexBlurb = document.createElement('span');
  indexBlurb.className = 'blurb';
  indexBlurb.textContent = 'Index served by misc/serve.mjs.';
  index.append(indexTitle, indexBlurb);
  panel.appendChild(index);

  wrap.append(toggle, panel);
  root.append(style, wrap);

  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close page menu' : 'Open page menu');
    if (open) panel.querySelector('a')?.focus();
  };

  toggle.addEventListener('click', () => setOpen(panel.hidden));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  // Clicks land on the host element, not its shadow children, so comparing
  // against `host` is enough to tell inside from outside.
  document.addEventListener('click', (event) => {
    if (!panel.hidden && event.target !== host) setOpen(false);
  });

  host.dataset.skin = pageIsDark() ? 'dark' : 'light';
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Re-measure on the next frame, once the page's own tokens have swapped.
    requestAnimationFrame(() => {
      host.dataset.skin = pageIsDark() ? 'dark' : 'light';
    });
  });

  document.body.appendChild(host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', build, { once: true });
} else {
  build();
}
