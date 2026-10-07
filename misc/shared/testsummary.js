// Shared logic for the misc/*-ui pages.
//
// These pages have no build step, so this file is loaded as a native ES module
// (`<script type="module">` + a relative import). It holds everything more than
// one page needs: the Treeherder/Taskcluster fetch helpers, the mirror of
// ui/helpers/testSummary.js that turns a summary artifact into groups and
// tests, the bug-suggestion matching the Summary tab does, and the tab
// comparison both the preview page and the divergence scanner report on.
//
// Keep the testSummary section in sync with ui/helpers/testSummary.js, and the
// bug-suggestion section in sync with FailureSummaryTab.jsx — they are mirrors
// of the real UI, not imports of it.
//
// Because this is a module, the pages that use it must be served over http(s);
// opening index.html from file:// blocks the import.

const HOSTS = {
  localhost: 'http://localhost:8000',
  stage: 'https://treeherder.allizom.org',
  production: 'https://treeherder.mozilla.org',
};
// New pushes emit the summary at a fixed path; legacy pushes emit it as
// a suite-prefixed artifact (e.g. mochitest-browser-chrome_testsummary.jsonl).
// Prefer the fixed path, fall back to suffix discovery.
const SUMMARY_ARTIFACT_PATH = 'public/test_info/summary.jsonl';
const SUMMARY_ARTIFACT_SUFFIX = '_testsummary.jsonl';
const JOBS_PAGE_SIZE = 2000;
const JOB_CONCURRENCY = 100;
const BZ_BASE_URL = 'https://bugzilla.mozilla.org/';
// Mirrors ui/helpers/constants.js#thBugSuggestionLimit.
const BUG_SUGGESTION_LIMIT = 20;
// Mirrors ui/helpers/constants.js#requiredInternalOccurrences.
const REQUIRED_INTERNAL_OCCURRENCES = 3;
// How far back the "Latest finished push" button looks before giving up.
// Autoland routinely has a dozen-plus pushes in flight at once, so a
// shallow window comes back empty exactly when the repo is busiest; the
// statuses are fetched in one parallel round, so depth is cheap.
const LATEST_PUSH_SCAN = 30;

// ---------------------------------------------------------------------
// HTTP + Treeherder/Taskcluster helpers.
// ---------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

// `signal` is threaded explicitly rather than kept in a module-level
// variable: the "Latest finished push" lookup and a summary run can be in
// flight at the same time, and stopping one must not cancel the other.
const isAbort = (err) => err?.name === 'AbortError';

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

async function fetchText(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

async function getTcRootUrl(serverUrl, project, signal) {
  const repos = await fetchJson(`${serverUrl}/api/repository/`, signal);
  const repository = repos.find((r) => r.name === project);
  if (!repository) throw new Error(`Unknown project: ${project}`);
  return repository.tc_root_url;
}

async function resolvePush(serverUrl, project, revision, signal) {
  const data = await fetchJson(
    `${serverUrl}/api/project/${encodeURIComponent(project)}/push/?revision=${encodeURIComponent(revision)}`,
    signal,
  );
  if (!data.results.length)
    throw new Error(`No push with revision ${revision} on ${project}`);
  return data.results[0];
}

async function getPushRevision(serverUrl, project, pushId, signal) {
  const push = await fetchJson(
    `${serverUrl}/api/project/${encodeURIComponent(project)}/push/${pushId}/`,
    signal,
  );
  return push.revision;
}

// Nothing left to report. `push/<id>/status/` already drops tier-3 and
// classified jobs (Push.get_status), so this is the same notion of "done"
// the job view shows. `completed > 0` guards against a push whose
// decision task hasn't scheduled anything yet — all three counts are zero
// there, which is empty, not finished.
const pushIsFinished = (status) =>
  (status.pending || 0) === 0 &&
  (status.running || 0) === 0 &&
  (status.completed || 0) > 0;

// The newest push whose jobs have all reported, or null if none of the
// last `limit` qualify. The very newest push on an active repo is nearly
// always still running, and a push loaded mid-flight renders a partial
// report — hence walking back rather than just taking the head.
//
// Statuses are fetched concurrently: serialising a dozen round trips to
// answer one click is the difference between instant and sluggish. A
// status that fails to load is treated as unfinished rather than
// aborting the search.
async function findLatestFinishedPush(serverUrl, project, limit) {
  const data = await fetchJson(
    `${serverUrl}/api/project/${encodeURIComponent(project)}/push/?count=${limit}`,
  );
  const pushes = data.results || [];
  const statuses = await Promise.all(
    pushes.map((push) =>
      fetchJson(
        `${serverUrl}/api/project/${encodeURIComponent(project)}/push/${push.id}/status/`,
      ).catch(() => null),
    ),
  );
  // `results` is newest-first, so the first match is the latest one.
  const index = statuses.findIndex((s) => s && pushIsFinished(s));
  return index === -1 ? null : pushes[index];
}

// The jobs endpoint returns a columnar form: `results` is an array of
// arrays, decoded against `job_property_names`.
async function getJobs(serverUrl, project, pushId, signal) {
  const jobs = [];
  let offset = 0;
  for (;;) {
    const data = await fetchJson(
      `${serverUrl}/api/project/${encodeURIComponent(project)}/jobs/?push_id=${pushId}&count=${JOBS_PAGE_SIZE}&offset=${offset}`,
      signal,
    );
    const names = data.job_property_names;
    const page = (data.results || []).map((row) =>
      Array.isArray(row)
        ? Object.fromEntries(names.map((n, idx) => [n, row[idx]]))
        : row,
    );
    jobs.push(...page);
    if (page.length < JOBS_PAGE_SIZE) break;
    offset += JOBS_PAGE_SIZE;
  }
  return jobs;
}

async function listArtifacts(tcRootUrl, taskId, run, signal) {
  const url = `${tcRootUrl}/api/queue/v1/task/${taskId}/runs/${run}/artifacts`;
  try {
    const data = await fetchJson(url, signal);
    return data.artifacts || [];
  } catch (e) {
    // A stopped run isn't a missing artifact — swallowing it here would
    // turn "the user pressed Stop" into "this task has nothing".
    if (isAbort(e)) throw e;
    // Expired tasks / missing runs are expected; skip silently.
    return [];
  }
}

// Mirrors ui/helpers/url.js's isResourceUsageProfile/getPerfAnalysisUrl.
function isResourceUsageProfile(fileName) {
  return [
    'profile_build_resources.json',
    'profile_resource-usage.json',
  ].includes(fileName);
}

function getPerfAnalysisUrl(url, job) {
  let profilerUrl = `https://profiler.firefox.com/from-url/${encodeURIComponent(url)}`;
  if (job && isResourceUsageProfile(url.split('/').pop())) {
    const profileName = `${job.job_type_name} (${job.task_id}.${job.retry_id})`;
    profilerUrl += `?profileName=${encodeURIComponent(profileName)}`;
  }
  return profilerUrl;
}

async function getBugSuggestions(serverUrl, project, jobId, signal) {
  try {
    const data = await fetchJson(
      `${serverUrl}/api/project/${encodeURIComponent(project)}/jobs/${jobId}/bug_suggestions/`,
      signal,
    );
    return Array.isArray(data) ? data : [];
  } catch (e) {
    // As in listArtifacts: an aborted request must not read as "this job
    // has no bug suggestions", which would render a job as clean when it
    // was simply never loaded.
    if (isAbort(e)) throw e;
    return [];
  }
}

// Runs `worker` over `items` with at most `limit` in flight at once.
// Aborting stops new items being picked up; the ones already in flight
// are left to settle, so the caller gets a stable result rather than a
// collection still being written to.
async function mapWithConcurrency(items, limit, worker, signal) {
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      if (signal?.aborted) return;
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runNext),
  );
}

// ---------------------------------------------------------------------
// Ported from ui/helpers/testSummary.js. Keep in sync with that file —
// this is a browser-side mirror, not an import, since these pages have no
// build step.
// ---------------------------------------------------------------------

const NO_GROUP = '(no group)';
const INCOMPLETE_STATUS = 'CRASH';
const HARNESS_STATUS = 'ERROR';
const FAILURE_LOG_LEVELS = new Set(['ERROR', 'CRITICAL']);
const TEST_STATUSES = [
  'PASS',
  'FAIL',
  'SKIP',
  'TIMEOUT',
  'ERROR',
  'CRASH',
];

const safeParseLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const parseLines = (content) => {
  if (typeof content !== 'string') return [];
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeParseLine)
    .filter(Boolean);
};

const emptyCounts = () => {
  const counts = { total: 0 };
  TEST_STATUSES.forEach((status) => {
    counts[status] = 0;
  });
  return counts;
};

const tallyStatus = (counts, status) => {
  counts.total += 1;
  if (status in counts) {
    counts[status] += 1;
  } else {
    counts[status] = (counts[status] || 0) + 1;
  }
};

const durationOf = (start, end) =>
  Number.isFinite(start) && Number.isFinite(end) ? end - start : null;

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

// mozharness logs one console line per line of a message, splitting where
// Python's str.splitlines() does (the information separators aside).
const PYTHON_LINE_BREAK_RE = /\r\n|[\n\r\v\f\x85\u2028\u2029]/;

// Mirrors get_cleaned_line() of the backend (treeherder/model/error_summary.py),
// which turns a log line into the text the classic Failure Summary shows. An
// `error_line` message has no mozharness prefix to strip already.
const cleanedLine = (message) =>
  message
    .trim()
    .replace(/(?:PID \d+|GECKO\(\d+\)) \| +/g, '')
    .replace(/.cpp:[0-9]+/g, '.cpp:X')
    .replace(/\[Child [0-9]+, [a-zA-Z]+ Thread/g, '[Child X, Y Thread')
    .replace(/\[Parent [0-9]+, [a-zA-Z]+ Thread/g, '[Parent X, Y Thread')
    .replace(/^\[\d+\] +/, '');

// The log parser keeps the first 500 characters of a line (MAX_LINE_LENGTH in
// treeherder/log_parser/artifactbuilders.py), run-task's "[task <time>] "
// stamp (37) and mozharness's "HH:MM:SS LEVEL - " prefix (20) included.
const CLASSIC_MESSAGE_LENGTH = 500 - 37 - 20;

// The classic "TEST-UNEXPECTED-<status> | test | msg" failure line of a test
// result.
const testFailureLine = (status, testName, message) =>
  `TEST-UNEXPECTED-${status} | ${testName}${message ? ` | ${message}` : ''}`;

// Mirrors the "FAILURE-TYPE | testNameOrFilePath | message" branch of the
// backend's get_error_search_term_and_path() (treeherder/model/error_summary.py)
// so a harness failure line gets the same `path_end` the bug_suggestions API
// derives from it, and the two can be matched.
const LEAK_RE = /\d+ bytes leaked \(.+\)$|leak at .+$/;
const REFTEST_RE = /\s+[=!]=\s+.*/;
const MARIONETTE_RE = /.+marionette([_harness/]?).*\/test_.+.py ([A-Za-z]+).+/;

const pathEndOfLine = (line) => {
  const tokens = line.split(' | ');
  if (tokens.length < 3) return null;
  const isCrash = tokens[0].includes('PROCESS-CRASH');
  const message = isCrash ? tokens[1] : tokens[2];
  if (LEAK_RE.test(message)) return null;
  let path = (isCrash ? tokens[2] : tokens[1])
    .replace(REFTEST_RE, '')
    .replace(/\\/g, '/');
  if (MARIONETTE_RE.test(path)) path = `${path.split('.py ')[0]}.py`;
  return path;
};

// `test_end` statuses that say the run passed. A failure reported for the run
// after such an end (a shutdown leak) is its real result.
const PASSING_STATUSES = new Set(['PASS', 'OK']);

// CI builds embed source paths under "checkouts/gecko/"; the repo-relative
// part is what a reader wants.
const CHECKOUTS_GECKO = 'checkouts/gecko/';

const repoRelativePath = (path) => {
  const index = path.lastIndexOf(CHECKOUTS_GECKO);
  return index === -1 ? path : path.slice(index + CHECKOUTS_GECKO.length);
};

// "<file>:<lineno>[:<column>]" of a ubsan_error record, or null when the
// runtime printed no source location.
const sourceLocationOf = (record, display = false) => {
  if (!record.file) return null;
  let location = display ? repoRelativePath(record.file) : record.file;
  if (Number.isFinite(record.lineno)) {
    location += `:${record.lineno}`;
    if (Number.isFinite(record.column)) location += `:${record.column}`;
  }
  return location;
};

// The SUMMARY line compiler-rt prints for a report: the only line of it
// Treeherder's log parser keeps for the classic Failure Summary.
const ubsanClassicLine = (record) => {
  const kind = record.kind || 'undefined-behavior';
  const location = sourceLocationOf(record);
  return `SUMMARY: UndefinedBehaviorSanitizer: ${kind}${
    location ? ` ${location}` : ''
  }`;
};

// Objects whose leak the TBPL formatter names in the line instead of the
// byte count, in the order it checks them.
const BIG_LEAKERS = [
  'nsGlobalWindowInner',
  'nsGlobalWindowOuter',
  'Document',
  'nsDocShell',
  'BrowsingContext',
  'SystemGlobal',
];

// The TEST-UNEXPECTED-FAIL line TbplFormatter.mozleak_total prints for a
// failing leak total, or null when the total is not a failure.
const leakcheckLine = (record) => {
  const { process, bytes, threshold, objects = [] } = record;
  if (bytes === null || bytes === undefined) {
    if (record.induced_crash || record.ignore_missing) return null;
    return `TEST-UNEXPECTED-FAIL | leakcheck | ${process} missing output line for total leaks!`;
  }
  if (bytes === 0 || !(bytes > (threshold ?? 0))) return null;
  const big = BIG_LEAKERS.find((name) => objects.includes(name));
  if (big) {
    return `TEST-UNEXPECTED-FAIL | leakcheck large ${big} | ${record.scope}`;
  }
  const shown = objects.slice(0, 5).join(', ');
  const summary = objects.length > 5 ? `${shown}, ...` : shown;
  return `TEST-UNEXPECTED-FAIL | leakcheck | ${process} ${bytes} bytes leaked (${summary})`;
};

// The ERROR line TbplFormatter.lsan_summary prints, or null when every leak
// was allowed.
const lsanSummaryLine = (record) => {
  if (record.allowed) return null;
  return `ERROR | LeakSanitizer | SUMMARY: AddressSanitizer: ${record.bytes} byte(s) leaked in ${record.allocations} allocation(s).`;
};

// The TEST-UNEXPECTED-FAIL line TbplFormatter.lsan_leak prints, or null when
// the leak matched an allow rule.
const lsanLeakLine = (record) => {
  if (record.allowed_match) return null;
  return `TEST-UNEXPECTED-FAIL | LeakSanitizer | leak at ${(record.frames ?? []).join(', ')}`;
};

// Drops empty entries and repeats while keeping order. A failing
// test's message list is assembled from two sources that legitimately
// overlap — the same text arriving as both a subtest result and the
// `test_end` message would otherwise render as two identical lines.
const dedupe = (messages) => {
  const seen = new Set();
  return messages.filter((message) => {
    // Compared without trailing punctuation so the same text reported as
    // both a subtest ("Test timed out.") and a `test_end` message ("Test
    // timed out") collapses to one line.
    const key = (message || '').replace(/[.\s]+$/, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function buildTestSummary(content) {
  const lines = parseLines(content);

  const groups = new Map();

  const recordEntry = (entry, key = entry.test) => {
    const groupName = entry.group || NO_GROUP;
    if (!groups.has(groupName)) {
      groups.set(groupName, new Map());
    }
    const tests = groups.get(groupName);

    if (!tests.has(key)) {
      const test = { name: entry.test, results: [] };
      if (entry.harness) {
        test.harness = true;
        test.pathEnd = entry.pathEnd;
      }
      tests.set(key, test);
    }
    const result = {
      status: entry.status,
      success: entry.success,
      message: entry.message,
      messages: entry.messages || (entry.message ? [entry.message] : []),
      start: entry.start,
      end: entry.end,
      duration: entry.duration,
    };
    // The text the classic Failure Summary shows for this result, when it is
    // not the message itself.
    if (entry.classicLine) result.classicLine = entry.classicLine;
    tests.get(key).results.push(result);
    return result;
  };

  const pending = new Map();
  let currentGroup = null;
  // Groups seen so far, to file a harness line under the manifest it names
  // even when it arrives after that group's `group_end`.
  const knownGroups = new Set();
  let harnessLines = 0;
  // The run of the latest `test_start` until its `test_end`, to file an
  // `error_line` under the group of the test that printed it.
  let openRun = null;
  // Text of every console line the records so far printed as a failure, one
  // per line of a multi-line message, to drop the `error_line` records
  // repeating one.
  const coveredLines = new Set();
  const coverKey = (text) => text.trim().replace(/\s+/g, ' ');
  const cover = (text) => {
    if (!text) return;
    text.split(PYTHON_LINE_BREAK_RE).forEach((part) => {
      coveredLines.add(coverKey(part));
    });
  };

  // The result each test's latest `test_end` produced, so the subtest results
  // the harness reports after that `test_end` can still enrich it.
  const lastClosed = new Map();
  // Closed results a late status has already overwritten the messages of.
  const replayedInto = new WeakSet();

  const takePending = (testName) => {
    const queue = pending.get(testName);
    return queue && queue.length ? queue.shift() : null;
  };

  // File a failure that is not a test result (a harness line, a sanitizer
  // report, a leak total) as its own entry: two identical lines are two
  // failures, not one test run twice. An `error_line` (`consoleLine`) covers
  // nothing, so a second identical one is still filed.
  const recordHarnessLine = ({
    message,
    group,
    classicLine,
    consoleLine = false,
  }) => {
    if (!consoleLine) {
      cover(message);
      cover(classicLine);
    }
    const pathEnd = pathEndOfLine(message);
    harnessLines += 1;
    recordEntry(
      {
        test: pathEnd || message,
        group,
        status: HARNESS_STATUS,
        success: false,
        message,
        messages: [message],
        start: null,
        end: null,
        duration: null,
        harness: true,
        pathEnd,
        classicLine,
      },
      `harness:${harnessLines}`,
    );
  };

  lines.forEach((line) => {
    if (!line) return;

    switch (line.action) {
      case 'group_start':
        if (line.name) knownGroups.add(line.name);
        currentGroup = line.name || currentGroup;
        return;
      case 'group_end':
        currentGroup = null;
        return;
      case 'test_start': {
        if (!line.test) return;
        const run = {
          group: line.group || currentGroup,
          start: finiteOrNull(line.time),
          subtestFailures: [],
        };
        if (!pending.has(line.test)) pending.set(line.test, []);
        pending.get(line.test).push(run);
        openRun = run;
        return;
      }
      case 'test_status': {
        if (!line.test || !('expected' in line)) return;
        // Either field alone can carry the whole signal: mochitest
        // reports a timeout as `subtest: 'Test timed out.'` with an empty
        // `message`, so gating on `message` drops the failure entirely.
        const text = [line.subtest, line.message]
          .filter(Boolean)
          .join(' - ');
        cover(testFailureLine(line.status, line.test, text));
        if (!text) return;
        const queue = pending.get(line.test);
        const run = queue && queue.length ? queue[0] : null;
        if (run) {
          run.subtestFailures.push(text);
          return;
        }
        // No run open: xpcshell is replaying the log of the run that just
        // ended, or mochitest is reporting a shutdown leak (found once the
        // browser exited) of a test whose `test_end` said it passed. Fold
        // the failure into that result, replacing its messages the first
        // time. A run that passed fails on it; a run the harness closed as
        // an expected failure it will retry is left alone, that later run
        // being the result.
        const closed = lastClosed.get(line.test);
        if (!closed) return;
        if (closed.success) {
          if (!PASSING_STATUSES.has(closed.status)) return;
          closed.success = false;
          closed.status = line.status;
        }
        if (!replayedInto.has(closed)) {
          replayedInto.add(closed);
          closed.messages = [];
        }
        closed.messages = dedupe([...closed.messages, text]);
        closed.message = closed.messages.join(' | ');
        return;
      }
      case 'test_end': {
        if (!line.test) return;
        const run = takePending(line.test);
        if (run && run === openRun) openRun = null;
        const start = run ? run.start : null;
        const end = finiteOrNull(line.time);
        const success = !('expected' in line);
        if (!success) {
          cover(testFailureLine(line.status, line.test, line.message));
        }
        const subtestFailures = run?.subtestFailures || [];
        // Subtest messages are usually the more informative ones, but
        // the `test_end` message is what names the failure mode ("Test
        // timed out") — keeping only the subtests hides the cause behind
        // whatever incidental line the harness logged last. Keep both.
        const messages = dedupe(
          success ? [line.message] : [...subtestFailures, line.message],
        );
        const message = messages.length ? messages.join(' | ') : null;
        const result = recordEntry({
          test: line.test,
          group: line.group || run?.group || currentGroup,
          status: line.status,
          success,
          message,
          messages,
          start,
          end,
          duration: durationOf(start, end),
        });
        lastClosed.set(line.test, result);
        return;
      }
      case 'crash': {
        const testName = line.test || line.signature || '(unknown test)';
        recordEntry({
          test: testName,
          group: line.group || currentGroup,
          status: 'CRASH',
          success: false,
          message: line.signature || null,
          start: null,
          end: null,
          duration: null,
        });
        return;
      }
      case 'log': {
        // Only ERROR/CRITICAL lines reach the artifact (mozlog's
        // TestSummaryFormatter filters the rest); be defensive anyway.
        if (!line.message || !FAILURE_LOG_LEVELS.has(line.level)) return;
        const { message } = line;
        const tokens = message.split(' | ');
        const scope =
          tokens.length > 1 ? tokens[tokens.length - 1].trim() : '';
        recordHarnessLine({
          message,
          group: knownGroups.has(scope) ? scope : currentGroup,
        });
        return;
      }
      case 'ubsan_error': {
        // Shown as "UndefinedBehaviorSanitizer | <test> | <message> at
        // <file>:<lineno>:<column>", the failure-line shape whose middle
        // token is the test path. The test path is unknown between tests.
        if (!line.message) return;
        const location = sourceLocationOf(line, true);
        const detail = location
          ? `${line.message} at ${location}`
          : line.message;
        const message = line.test
          ? `UndefinedBehaviorSanitizer | ${line.test} | ${detail}`
          : `UndefinedBehaviorSanitizer | ${detail}`;
        recordHarnessLine({
          message,
          group:
            line.group ||
            (knownGroups.has(line.scope) ? line.scope : currentGroup),
          classicLine: ubsanClassicLine(line),
        });
        return;
      }
      case 'mozleak_total': {
        // Shown as the line the TBPL formatter prints, which is what the
        // classic Failure Summary has for it.
        const message = leakcheckLine(line);
        if (!message) return;
        recordHarnessLine({
          message,
          group: knownGroups.has(line.scope) ? line.scope : currentGroup,
        });
        return;
      }
      case 'lsan_summary': {
        // The report's totals carry no scope: filed under the open group.
        const message = lsanSummaryLine(line);
        if (!message) return;
        recordHarnessLine({ message, group: currentGroup });
        return;
      }
      case 'lsan_leak': {
        const message = lsanLeakLine(line);
        if (!message) return;
        recordHarnessLine({
          message,
          group: knownGroups.has(line.scope) ? line.scope : currentGroup,
        });
        return;
      }
      case 'error_line': {
        // A console line the classic Failure Summary shows, written after the
        // record that printed it. Most repeat a record above; the others
        // (e.g. a mochitest reftest assertion's image comparison report, a
        // child process's output) are filed like a harness line, shown as
        // the classic tab shows them and matched on the text it cut. An empty
        // one is the bare prefix of a message's trailing newline.
        const printed = (line.message || '').trimEnd();
        if (!printed.trim() || coveredLines.has(coverKey(printed))) return;
        const message = cleanedLine(printed);
        const classicLine = cleanedLine(
          printed.slice(0, CLASSIC_MESSAGE_LENGTH),
        );
        recordHarnessLine({
          message,
          group: openRun?.group || currentGroup,
          classicLine: classicLine === message ? undefined : classicLine,
          consoleLine: true,
        });
        return;
      }
      default:
    }
  });

  pending.forEach((queue, testName) => {
    queue.forEach((run) => {
      recordEntry({
        test: testName,
        group: run.group,
        status: INCOMPLETE_STATUS,
        success: false,
        message: 'Test started but never finished',
        start: run.start,
        end: null,
        duration: null,
      });
    });
  });

  const overallCounts = emptyCounts();
  const overallRealFailCounts = {};

  const groupList = Array.from(groups.entries()).map(([name, tests]) => {
    const groupCounts = emptyCounts();

    const testList = Array.from(tests.values()).map((test) => {
      const lastResult = test.results[test.results.length - 1];
      const { status, success } = lastResult;
      // Harness failures are not tests: they count as failures below but
      // stay out of the test tallies, so "N tests" keeps meaning tests.
      if (!test.harness) {
        tallyStatus(groupCounts, status);
        tallyStatus(overallCounts, status);
      }
      if (!success) {
        overallRealFailCounts[status] =
          (overallRealFailCounts[status] || 0) + 1;
      }
      return {
        ...test,
        status,
        success,
        retried: test.results.length > 1,
      };
    });

    return { name, counts: groupCounts, tests: testList };
  });

  return {
    groups: groupList,
    counts: overallCounts,
    realFailCounts: overallRealFailCounts,
  };
}

function buildFailureSuggestions(summary) {
  if (!summary) return [];

  const suggestions = [];
  summary.groups.forEach((group) => {
    group.tests.forEach((test) => {
      if (test.success) return;
      const lastResult = test.results[test.results.length - 1];
      // A single failing test can emit several unexpected messages (e.g.
      // one subtest failure per line). Render each as its own failure
      // line instead of collapsing them into one joined line.
      const messages = lastResult.messages?.length
        ? lastResult.messages
        : [lastResult.message].filter(Boolean);
      if (!messages.length) messages.push(null);
      messages.forEach((message, index) => {
        // A harness line already is a complete failure line; a test result
        // is rebuilt into the classic "TEST-UNEXPECTED-<status> | test | msg".
        const search = test.harness
          ? message
          : testFailureLine(test.status, test.name, message);
        const suggestion = {
          search,
          path_end: test.harness ? test.pathEnd : test.name,
          // Bug suggestions match on test path, so every line of a test
          // would otherwise get the same bugs. Only the first carries them.
          primary: index === 0,
          bugs: { open_recent: [], all_others: [] },
        };
        // What the classic Failure Summary shows for this line when that is
        // not `search` itself (a UBSan report), to match the two summaries.
        if (lastResult.classicLine) {
          suggestion.classicLine = lastResult.classicLine;
        }
        suggestions.push(suggestion);
      });
    });
  });
  return suggestions;
}

const normalizePath = (path) =>
  (path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const pathsMatch = (testPath, bugPath) => {
  if (!testPath || !bugPath) return false;
  const a = normalizePath(testPath);
  const b = normalizePath(bugPath);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
};

const bugKey = (bug) => bug.id ?? bug.internal_id;

const mergeBugs = (target, incoming) => {
  const seen = new Set(target.map(bugKey));
  incoming.forEach((bug) => {
    const key = bugKey(bug);
    if (!seen.has(key)) {
      seen.add(key);
      target.push(bug);
    }
  });
};

const decorateBugs = (suggestion) => {
  const { bugs } = suggestion;
  bugs.too_many_open_recent =
    bugs.open_recent.length > BUG_SUGGESTION_LIMIT;
  bugs.too_many_all_others =
    bugs.all_others.length > BUG_SUGGESTION_LIMIT;
  suggestion.valid_open_recent =
    bugs.open_recent.length > 0 && !bugs.too_many_open_recent;
  suggestion.valid_all_others =
    bugs.all_others.length > 0 &&
    !bugs.too_many_all_others &&
    !bugs.too_many_open_recent;
  suggestion.showBugSuggestions =
    suggestion.valid_open_recent || suggestion.valid_all_others;
};

function matchBugSuggestions(failureSuggestions, bugSuggestions) {
  if (!failureSuggestions || !failureSuggestions.length)
    return failureSuggestions;
  if (!bugSuggestions || !bugSuggestions.length) {
    failureSuggestions.forEach(decorateBugs);
    return failureSuggestions;
  }

  failureSuggestions.forEach((suggestion) => {
    // Non-primary lines share a test path with the primary one; attaching
    // bugs to them too would duplicate the suggestions under every line.
    if (suggestion.primary === false) {
      decorateBugs(suggestion);
      return;
    }
    const matches = bugSuggestions.filter((bugSuggestion) =>
      pathsMatch(suggestion.path_end, bugSuggestion.path_end),
    );
    matches.forEach((match) => {
      mergeBugs(
        suggestion.bugs.open_recent,
        match.bugs?.open_recent || [],
      );
      mergeBugs(suggestion.bugs.all_others, match.bugs?.all_others || []);
    });
    decorateBugs(suggestion);
  });

  return failureSuggestions;
}

// Ported from FailureSummaryTab.jsx#isGenericFailure /
// #filterGenericFailures — used to build the Failure Summary Tab
// column's suggestion list from the raw bug_suggestions response, the
// same way the real FailureSummaryTab does in #loadBugSuggestions.
function isGenericFailure(search, pathEnd) {
  const match =
    search.match(/^TEST-UNEXPECTED-\w+ \| (.+?) \| finished in \d+ms$/) ||
    search.match(
      /^TEST-UNEXPECTED-\w+ \| (.+?) \| xpcshell return code: -?\d+$/,
    );
  return match && match[1] === pathEnd;
}

function filterGenericFailures(suggestions) {
  if (suggestions.length <= 1) return suggestions;

  const testPathsWithSpecificErrors = new Set();
  suggestions.forEach((suggestion) => {
    if (
      suggestion.path_end &&
      !isGenericFailure(suggestion.search, suggestion.path_end)
    ) {
      testPathsWithSpecificErrors.add(suggestion.path_end);
    }
  });

  const filtered = suggestions.filter((suggestion) => {
    if (
      /^\[taskcluster:error\] exit status -?\d+$/.test(suggestion.search)
    ) {
      return false;
    }
    return (
      !isGenericFailure(suggestion.search, suggestion.path_end) ||
      !testPathsWithSpecificErrors.has(suggestion.path_end)
    );
  });

  const seenTestPaths = new Set();
  filtered.forEach((suggestion) => {
    if (!suggestion.path_end) {
      suggestion.showBugSuggestions = true;
      return;
    }
    suggestion.showBugSuggestions = !seenTestPaths.has(
      suggestion.path_end,
    );
    seenTestPaths.add(suggestion.path_end);
  });

  return filtered;
}

// Ported from ui/helpers/testSummary.js#isWorkerLine / #withWorkerLines: the
// Summary tab appends the lines the Taskcluster worker wrote itself (a
// max-run-time abort), which no summary.jsonl can hold, with their bugs. Only
// the ones the classic tab shows are taken, and the inputs are not modified.
function isWorkerLine(search) {
  return /^\[taskcluster:error\] /.test(search || '');
}

function withWorkerLines(failureSuggestions, bugSuggestions) {
  const copies = (bugSuggestions || []).map((suggestion) => ({
    ...suggestion,
    bugs: {
      open_recent: [...(suggestion.bugs?.open_recent || [])],
      all_others: [...(suggestion.bugs?.all_others || [])],
    },
  }));
  const workerLines = filterGenericFailures(copies).filter((suggestion) =>
    isWorkerLine(suggestion.search),
  );
  workerLines.forEach(decorateBugs);
  return [...(failureSuggestions || []), ...workerLines];
}

function normalizeSearch(search) {
  return (search || '').trim();
}

const BARE_PREFIX_LINE_RE = /^\d\d:\d\d:\d\d +(?:ERROR|CRITICAL|FATAL) -$/;

// The text a suggestion is compared on across the two tabs: the classic
// Failure Summary line it stands for when it has one (a UBSan report),
// else its search string.
function comparableSearch(suggestion) {
  return normalizeSearch(suggestion.classicLine ?? suggestion.search);
}

// Compares the two columns by normalized search string — the only notion
// of "same failure" available. Used both by the ⚠ diff note and by the
// job filter that hides jobs whose two tabs are identical.
function diffSearches(suggestions, failureSuggestions) {
  const summarySearches = new Set(suggestions.map(comparableSearch));
  const failureSearches = new Set(failureSuggestions.map(comparableSearch));
  // A classic line that is only mozharness's "HH:MM:SS LEVEL -" prefix, the
  // empty line printed for a message's trailing newline, is one the summary
  // drops on purpose: it counts as matched.
  failureSearches.forEach((search) => {
    if (BARE_PREFIX_LINE_RE.test(search)) summarySearches.add(search);
  });
  const onlyInSummary = [...summarySearches].filter(
    (search) => !failureSearches.has(search),
  ).length;
  const onlyInFailureSummary = [...failureSearches].filter(
    (search) => !summarySearches.has(search),
  ).length;
  return {
    summarySearches,
    failureSearches,
    onlyInSummary,
    onlyInFailureSummary,
  };
}

function jobLabel(job) {
  const symbol = job.job_type_symbol ? `[${job.job_type_symbol}] ` : '';
  return `${symbol}${job.job_type_name || 'job'}`;
}

// Same identity as the job-view link's selectedTaskRun, so the anchor
// stays stable across runs of the same push.
const jobAnchorId = (job) => `job-${job.task_id}-${job.retry_id ?? 0}`;

// ---------------------------------------------------------------------
// Exports. Everything above is deliberately written as plain declarations so
// the bodies read the same here as they did inline in the pages; the public
// surface is collected in one place instead.
// ---------------------------------------------------------------------

export {
  // Configuration
  HOSTS,
  SUMMARY_ARTIFACT_PATH,
  SUMMARY_ARTIFACT_SUFFIX,
  JOB_CONCURRENCY,
  BZ_BASE_URL,
  BUG_SUGGESTION_LIMIT,
  REQUIRED_INTERNAL_OCCURRENCES,
  LATEST_PUSH_SCAN,
  // HTTP + Treeherder/Taskcluster
  HttpError,
  isAbort,
  fetchJson,
  fetchText,
  getTcRootUrl,
  resolvePush,
  getPushRevision,
  findLatestFinishedPush,
  getJobs,
  listArtifacts,
  isResourceUsageProfile,
  getPerfAnalysisUrl,
  getBugSuggestions,
  mapWithConcurrency,
  // Summary artifact -> groups/tests
  buildTestSummary,
  buildFailureSuggestions,
  // Bug suggestions
  decorateBugs,
  matchBugSuggestions,
  filterGenericFailures,
  isWorkerLine,
  withWorkerLines,
  // Tab comparison
  normalizeSearch,
  comparableSearch,
  diffSearches,
  // Job identity
  jobLabel,
  jobAnchorId,
};
