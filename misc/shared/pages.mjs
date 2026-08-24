// The one list of misc/*-ui pages.
//
// Both the burger nav (`shared/nav.js`, in the browser) and the local dev
// server (`misc/serve.mjs`, in Node) import this, so adding a page here is the
// only edit needed to make it appear in the menu and on the server's index.
//
// It is `.mjs` rather than `.js` because Node loads it too, and the repo's
// package.json has no `"type": "module"`.
//
// `slug` is both the URL path the pages already link to each other by
// (`../testsummary-audit/`) and, with a `-ui` suffix, the directory on disk.

export const PAGES = [
  {
    slug: 'testsummary-summarytab-preview',
    dir: 'testsummary-summarytab-preview-ui',
    title: 'Summary Tab Preview',
    blurb:
      'Renders the Summary and Failure Summary tabs for a job from its summary.jsonl artifact, with triage.',
  },
  {
    slug: 'testsummary-divergence',
    dir: 'testsummary-divergence-ui',
    title: 'TestSummary Divergence',
    blurb:
      'Scans recent pushes and lists every job whose two tabs disagree by more than a threshold.',
  },
  {
    slug: 'testsummary-inventory',
    dir: 'testsummary-inventory-ui',
    title: 'TestSummary Inventory',
    blurb:
      'Which jobs on a push emit a summary artifact, and what shape those artifacts have.',
  },
  {
    slug: 'testsummary-audit',
    dir: 'testsummary-audit-ui',
    title: 'Field Audit',
    blurb:
      'Field-by-field audit of summary.jsonl against what the Summary tab actually consumes.',
  },
  {
    slug: 'compare-failure-summary',
    dir: 'compare-failure-summary-ui',
    title: 'Compare Failure Summary',
    blurb:
      'Diffs the Failure Summary bug suggestions between two Treeherder instances.',
  },
];
