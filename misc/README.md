# misc/

Standalone, buildless tools that sit outside the Treeherder app. The `*-ui/`
directories are single-file HTML pages that talk to Treeherder and Taskcluster
straight from the browser; `shared/` holds what more than one of them needs.

## Serving the pages

```bash
node misc/serve.mjs              # http://localhost:8010
node misc/serve.mjs --port 9000  # or PORT=9000 node misc/serve.mjs
```

The pages need an origin — two of them import `shared/testsummary.js` as a
native ES module, which `file://` refuses to load. The server has no
dependencies and serves `misc/` as the document root, with one rule on top: it
maps `/<slug>/` onto `<slug>-ui/`, which is how the pages already cross-link to
each other. `/` lists everything.

| URL | Directory |
| --- | --- |
| `/testsummary-summarytab-preview/` | `testsummary-summarytab-preview-ui/` |
| `/testsummary-divergence/` | `testsummary-divergence-ui/` |
| `/testsummary-inventory/` | `testsummary-inventory-ui/` |
| `/testsummary-audit/` | `testsummary-audit-ui/` |
| `/compare-failure-summary/` | `compare-failure-summary-ui/` |

## The burger menu

Every page ends with:

```html
<script type="module" src="../shared/nav.js"></script>
```

That renders the menu in the top-right corner. It lives in a shadow root, so it
neither inherits nor leaks page CSS — which matters because the five pages
share no styling: three are dark-only, one is theme-aware, one is Bootstrap. It
picks a light or dark skin by measuring the page's rendered background.

## Adding a page

1. Create `misc/<slug>-ui/index.html`.
2. Add an entry to `shared/pages.mjs` — the menu and the server index both read
   it, and nothing else needs editing.
3. Include `shared/nav.js` at the end of `<body>`.
