#!/usr/bin/env node
/*
 * Collects the failing functional tests of one XWiki branch from ci.xwiki.org, joins them with the
 * open flickering issues on jira.xwiki.org, and (with --compare) says how each one fares on other
 * branches. Fetching and correlating only: the judgement calls belong to the SKILL.md that runs it.
 */

const CI = 'https://ci.xwiki.org';
const JIRA = 'https://jira.xwiki.org';
// Cloudflare serves a challenge page to browser user-agents; see okf/servers/jenkins.md.
const HEADERS = { 'User-Agent': 'curl/8.7.1', Accept: 'application/json' };
// "Flickering tests" (filter 14240), the list the Release Plan links to.
const FLICKER_JQL = 'labels = flickering AND status in (Open, "In Progress", Reopened)';
// The JIRA field holding the fully-qualified test, e.g. a.b.AllIT$NestedFooIT#bar.
const FLICKER_FIELD = 'customfield_10870';

const USAGE = `Usage: node triage.mjs --branch <branch> [options]

  --branch <name>    Branch to triage, e.g. stable-17.10.x or master (required)
  --repos <a,b,c>    Repos to check (default: xwiki-commons,xwiki-rendering,xwiki-platform)
  --compare <a,b,c>  Also report how each failing test fares on these branches
  --max <n>          Cap the reported failures (default 40)
  --json             Emit JSON instead of the Markdown report

Run it from inside a clone of the repo to also get how far the branch has moved since the build.
`;

function parseArgs(argv) {
  const out = { repos: ['xwiki-commons', 'xwiki-rendering', 'xwiki-platform'], compare: [], max: 40 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--branch') out.branch = argv[++i];
    else if (key === '--repos') out.repos = argv[++i].split(',').filter(Boolean);
    else if (key === '--compare') out.compare = argv[++i].split(',').filter(Boolean);
    else if (key === '--max') out.max = Number(argv[++i]);
    else if (key === '--json') out.json = true;
    else { console.error(`Unknown argument [${key}]\n\n${USAGE}`); process.exit(2); }
  }
  if (!out.branch) { console.error(USAGE); process.exit(2); }
  return out;
}

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

const enc = s => encodeURIComponent(s);
const tree = s => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

/** The jobs that gate a release: the main build of each repo, plus platform's environment matrix. */
function jobs(repos, branch) {
  const list = repos.map(repo => ({ label: repo, url: `${CI}/job/XWiki/job/${repo}/job/${enc(branch)}` }));
  if (repos.includes('xwiki-platform')) {
    list.push({
      label: 'env-tests',
      url: `${CI}/job/XWiki%20Environment%20Tests/job/xwiki-platform/job/${enc(branch)}`
    });
  }
  return list;
}

/** Most recent build that produced test results: ABORTED builds and FAILURE-before-tests report none. */
async function lastTestedBuild(jobUrl) {
  const data = await getJSON(`${jobUrl}/api/json?tree=${tree('builds[number,result,actions[failCount,totalCount]]')}`);
  for (const build of (data?.builds || []).slice(0, 10)) {
    const junit = (build.actions || []).find(action => action && action.totalCount != null);
    if (junit) return { number: build.number, result: build.result, ...junit };
  }
  return null;
}

/** The environment of a suite, e.g. "MariaDB latest, Jetty 12-jdk25, S3, Firefox". */
function environmentOf(suite) {
  const blocks = suite.enclosingBlockNames || [];
  const name = blocks[blocks.length - 1] || '';
  const env = name.split(' - Docker tests')[0].trim();
  return env && env !== name ? env : 'default';
}

/**
 * Jenkins names a case "method(Arg, Arg)", and "[2]" for one invocation of a parameterized test.
 * The bare "class#method" is what the JIRA field holds and what makes the invocations one row.
 */
const idOf = (className, name) => `${className}#${name.replace(/\([^)]*\)/g, '').replace(/\[\d+\]$/, '')}`;
// A whole-class setup failure or a forbidden-log assertion, not a test method.
const isPseudoTest = id => /#(initializationError|executionError)$/.test(id);

async function testResults(buildUrl) {
  const data = await getJSON(
    `${buildUrl}/testReport/api/json?tree=${tree('suites[enclosingBlockNames,cases[className,name,status,errorDetails]]')}`);
  const byTest = new Map();
  for (const suite of data?.suites || []) {
    const env = environmentOf(suite);
    for (const testCase of suite.cases || []) {
      const id = idOf(testCase.className, testCase.name);
      if (!byTest.has(id)) byTest.set(id, { id, failed: new Set(), ran: new Set(), skipped: new Set(), detail: '' });
      const test = byTest.get(id);
      if (testCase.status === 'SKIPPED') test.skipped.add(env);
      else test.ran.add(env);
      if (testCase.status === 'FAILED' || testCase.status === 'REGRESSION') {
        test.failed.add(env);
        if (!test.detail) test.detail = (testCase.errorDetails || '').split('\n')[0].slice(0, 200);
      }
    }
  }
  return byTest;
}

/** The commit the build actually ran, and how far the branch has moved since (when run in the repo). */
async function revision(buildUrl, branch) {
  const data = await getJSON(`${buildUrl}/api/json?tree=${tree('actions[lastBuiltRevision[SHA1,branch[name]]]')}`);
  const revisions = (data?.actions || []).filter(action => action?.lastBuiltRevision).map(a => a.lastBuiltRevision);
  const rev = revisions.find(r => (r.branch || []).some(b => (b.name || '').endsWith(branch)));
  if (!rev) return null;
  const { execSync } = await import('node:child_process');
  try {
    const behind = execSync(`git rev-list --count ${rev.SHA1}..origin/${branch}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    return { sha: rev.SHA1, behind: Number(behind.toString().trim()) };
  } catch {
    return { sha: rev.SHA1, behind: null };
  }
}

async function knownFlickers() {
  const data = await getJSON(
    `${JIRA}/rest/api/2/search?jql=${enc(FLICKER_JQL)}&maxResults=200&fields=summary,${FLICKER_FIELD}`);
  const byTest = new Map();
  const all = [];
  for (const issue of data?.issues || []) {
    const entry = { key: issue.key, summary: issue.fields.summary };
    all.push(entry);
    const ref = issue.fields[FLICKER_FIELD];
    if (ref) byTest.set(ref.trim().replace(/\(.*$/, ''), entry);
  }
  // Not every flicker issue fills the field in, so fall back to the summary — but only when it
  // names both the class and the method, since a bare method name matches far too much.
  return id => {
    const exact = byTest.get(id);
    if (exact) return exact;
    const [className, method] = id.split('#');
    const simpleName = className.split(/[.$]/).pop().replace(/^Nested/, '');
    return all.find(issue => issue.summary.includes(simpleName) && issue.summary.includes(method)) || null;
  };
}

/** @returns {Map} test id -> one row aggregating every job and environment of the branch. */
async function collect(branch, repos) {
  const builds = [];
  const tests = new Map();
  for (const job of jobs(repos, branch)) {
    const build = await lastTestedBuild(job.url);
    if (!build) { builds.push({ ...job, build: null }); continue; }
    const buildUrl = `${job.url}/${build.number}`;
    builds.push({ ...job, build, rev: await revision(buildUrl, branch) });
    for (const test of (await testResults(buildUrl)).values()) {
      if (!tests.has(test.id)) {
        tests.set(test.id, { id: test.id, jobs: new Set(), failed: new Set(), ran: new Set(), skipped: new Set(), detail: '' });
      }
      const row = tests.get(test.id);
      // Environments are namespaced by job so that the two jobs' "default" ones stay distinct.
      for (const env of test.failed) row.failed.add(`${job.label}/${env}`);
      for (const env of test.ran) row.ran.add(`${job.label}/${env}`);
      for (const env of test.skipped) row.skipped.add(`${job.label}/${env}`);
      if (test.failed.size) row.jobs.add(job.label);
      if (test.detail && !row.detail) row.detail = test.detail;
    }
  }
  return { builds, tests };
}

/**
 * A test that failed in every environment that ran it is broken; one that failed in some of them
 * flickers. A single environment cannot tell the two apart.
 */
function verdictOf(row) {
  if (row.ran.size < 2) return 'single env';
  return row.failed.size === row.ran.size ? 'systematic' : 'intermittent';
}

function report(branch, { builds, tests }, compareBranches, flickerFor, max) {
  const lines = [`# Test triage for [${branch}]`, ''];
  for (const job of builds) {
    if (!job.build) { lines.push(`- **${job.label}** — no build with test results`); continue; }
    const rev = job.rev;
    const staleness = !rev ? 'revision unknown'
      : `ran ${rev.sha.slice(0, 11)}` + (rev.behind == null ? '' : `, ${rev.behind} commit(s) behind the branch`);
    lines.push(`- **${job.label}** — #${job.build.number} ${job.build.result}, `
      + `${job.build.failCount}/${job.build.totalCount} failed, ${staleness}`);
  }

  const rows = [...tests.values()].filter(row => row.failed.size);
  const failures = rows.filter(row => !isPseudoTest(row.id));
  const pseudo = rows.filter(row => isPseudoTest(row.id));
  const order = { systematic: 0, 'single env': 1, intermittent: 2 };
  failures.sort((a, b) => order[verdictOf(a)] - order[verdictOf(b)]);

  lines.push('');
  if (!failures.length) lines.push('No failing test methods.');
  else {
    const columns = ['Test', 'Jobs', 'Failed/ran envs', 'Verdict', 'Known flicker', ...compareBranches];
    lines.push(`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`);
    for (const row of failures.slice(0, max)) {
      const flicker = flickerFor(row.id);
      lines.push('| ' + [
        row.id,
        [...row.jobs].join(', '),
        `${row.failed.size}/${row.ran.size}` + (row.skipped.size ? ` (+${row.skipped.size} skipped)` : ''),
        verdictOf(row),
        flicker ? `${flicker.key} open` : '—',
        ...compareBranches.map(b => row.compare?.[b] || '?')
      ].join(' | ') + ' |');
    }
    if (failures.length > max) lines.push(`| _…and ${failures.length - max} more_ |${columns.slice(1).map(() => ' |').join('')}`);
    lines.push('', '## First error line',
      ...failures.slice(0, max).map(row => `- \`${row.id}\`: ${row.detail || '(none)'}`));
  }

  if (pseudo.length) {
    lines.push('', '## Not test methods (module setup failure, or forbidden content in the logs)',
      ...pseudo.slice(0, max).map(row => `- \`${row.id}\` (${[...row.jobs].join(', ')}): ${row.detail || '(none)'}`));
    if (pseudo.length > max) lines.push(`- _…and ${pseudo.length - max} more_`);
  }
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
const target = await collect(args.branch, args.repos);

for (const branch of args.compare) {
  const other = await collect(branch, args.repos);
  for (const row of target.tests.values()) {
    if (!row.failed.size) continue;
    const test = other.tests.get(row.id);
    row.compare ??= {};
    row.compare[branch] = !test ? 'absent'
      : test.failed.size ? `failed ${test.failed.size}/${test.ran.size}`
        : test.ran.size ? 'passed' : 'skipped';
  }
}

const flickerFor = await knownFlickers();
if (args.json) {
  const replacer = (_key, value) => (value instanceof Set ? [...value] : value);
  console.log(JSON.stringify({
    branch: args.branch,
    builds: target.builds,
    failures: [...target.tests.values()].filter(row => row.failed.size)
      .map(row => ({ ...row, verdict: verdictOf(row), jira: flickerFor(row.id), pseudo: isPseudoTest(row.id) }))
  }, replacer, 2));
} else {
  console.log(report(args.branch, target, args.compare, flickerFor, args.max));
}
