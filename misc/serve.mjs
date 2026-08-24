#!/usr/bin/env node
//
// Static server for the misc/*-ui pages.
//
//   node misc/serve.mjs            # http://localhost:8010
//   node misc/serve.mjs --port 9000
//
// Two of the pages import `../shared/testsummary.js` as a native ES module, so
// they cannot be opened from file:// at all — they need an origin. This serves
// misc/ as the document root and, on top of that, maps the `../<slug>/` URLs
// the pages already link each other by onto the `<slug>-ui/` directories on
// disk. `/` renders an index of everything in shared/pages.mjs.
//
// No dependencies, and deliberately so: this sits outside the app's build.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGES } from './shared/pages.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PORT = 8010;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function parsePort(argv) {
  const flag = argv.indexOf('--port');
  const raw = flag === -1 ? process.env.PORT : argv[flag + 1];
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${raw}`);
    process.exit(1);
  }
  return port;
}

// `/testsummary-audit/` and `/testsummary-audit-ui/` both mean the same
// directory; the first is what the pages' own cross-links use.
function resolveOnDisk(pathname) {
  const decoded = decodeURIComponent(pathname);
  const [first, ...rest] = decoded.split('/').filter(Boolean);
  const page = PAGES.find(
    (candidate) => candidate.slug === first || candidate.dir === first,
  );
  const parts = page ? [page.dir, ...rest] : [first, ...rest].filter(Boolean);
  const relative = normalize(parts.join(sep));
  // normalize() has collapsed any `..`; anything still climbing is an escape.
  if (relative.startsWith('..') || relative.includes(`..${sep}`)) return null;
  return join(ROOT, relative);
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char],
  );
}

function indexPage() {
  const cards = PAGES.map(
    (page) => `      <li>
        <a href="/${page.slug}/">
          <span class="title">${escapeHtml(page.title)}</span>
          <span class="blurb">${escapeHtml(page.blurb)}</span>
          <span class="path">misc/${escapeHtml(page.dir)}/</span>
        </a>
      </li>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TestSummary tools — Treeherder misc</title>
    <style>
      :root {
        --bg: #0f1115;
        --surface: #171a21;
        --line: #2a2e38;
        --ink: #e4e6eb;
        --ink-dim: #9aa0ad;
        --accent: #7aa5ff;
        color-scheme: dark;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 48px 24px 64px;
        background: var(--bg);
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
          Helvetica, Arial, sans-serif;
        line-height: 1.5;
      }
      main { max-width: 760px; margin: 0 auto; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p.lede { margin: 0 0 32px; color: var(--ink-dim); max-width: 62ch; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
      a {
        display: block;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        color: inherit;
        text-decoration: none;
      }
      a:hover { border-color: var(--accent); }
      a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .title { display: block; font-size: 17px; font-weight: 600; }
      .blurb { display: block; margin-top: 4px; color: var(--ink-dim); }
      .path {
        display: block;
        margin-top: 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        color: var(--ink-dim);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>TestSummary tools</h1>
      <p class="lede">
        Static pages under <code>misc/</code>, served locally by
        <code>misc/serve.mjs</code>. They talk to production Treeherder and
        Taskcluster directly; the burger menu on each page comes back here.
      </p>
      <ul>
${cards}
      </ul>
    </main>
  </body>
</html>
`;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  // None of the pages ship an icon; answering keeps a 404 out of the console.
  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    send(res, 200, indexPage(), MIME['.html']);
    return;
  }

  const target = resolveOnDisk(pathname);
  if (!target) {
    send(res, 403, 'Forbidden');
    return;
  }

  let info = await statOrNull(target);
  let path = target;
  if (info?.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: `${pathname}/` });
      res.end();
      return;
    }
    path = join(target, 'index.html');
    info = await statOrNull(path);
  }

  if (!info?.isFile()) {
    send(res, 404, `Not found: ${pathname}`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res);
});

const port = parsePort(process.argv.slice(2));

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use — try: node misc/serve.mjs --port ${port + 1}`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  const base = `http://localhost:${server.address().port}`;
  console.log(`misc pages on ${base}`);
  for (const page of PAGES) console.log(`  ${base}/${page.slug}/  ${page.title}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
