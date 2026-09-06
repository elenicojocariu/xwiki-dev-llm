---
name: xwiki-release-test-triage
description: Triage the failing functional tests of an XWiki branch on ci.xwiki.org and say whether they block a release — the Release Plan's "verify that no tests are failing on the CI server, or that the failures are understood" step. Separates known flickers (open JIRA issues) from unknown flickers and from real breakages, checks whether each real breakage is already fixed on the other maintained branches, then reports and asks what to do. Use when preparing a release, or when asked to check/triage the CI or test status of a branch. To then fix one flicker use xwiki-fix-flickering-docker-test, to file its issue use xwiki-jira, to land a fix missing from a branch use xwiki-backport.
---

# Triage a branch's failing tests before releasing it

This is the first release-day gate, and its output is a decision, not a list: for every failing
test, either it is understood (a tracked flicker) or it is not (and someone must act before the
release). Report and **ask** — never fix, file or backport anything on your own here.

## 1. Collect

Run from inside an up-to-date clone of the repo (`git fetch origin <branch>` first, so the script
can tell how far the branch has moved since the build):

```bash
node <skill>/tools/triage.mjs --branch stable-17.10.x
node <skill>/tools/triage.mjs --branch stable-17.10.x --repos xwiki-platform --compare master,stable-18.4.x
```

It reads the main Jenkins job of each repo of the release train plus platform's Environment Tests
job, aggregates each test across every job and environment, and joins the failures with the open
flickering issues. `--json` gives the same data unformatted. Derive the `--compare` branches from
the maintained-branch policy in [[release]] plus `git branch -r 'origin/stable-*'` — the policy says
where a fix must *land*, the remote list says where it can be *observed*.

## 2. Check the revision before believing anything

The report's per-job line ends with the commit the build ran and how far the branch has moved since.
**A test whose fix was pushed after that commit is already fixed and is not a finding** — say so and
move on. This is the single most common way this triage goes wrong.

## 3. Read the verdicts

`Failed/ran envs` counts *environments*, not test cases, and drives the verdict:

- **systematic** — failed in every environment that ran it. Genuinely broken; needs an owner.
- **intermittent** — failed in some. A flicker.
- **single env** — only one environment ran it, which cannot tell the two apart. Resolve it with the
  `develocity` MCP, which holds the test's history across builds.

`(+N skipped)` means `assumeTrue` disabled the test elsewhere — a test that runs in one environment
only is invisible in the other job, so "green on the main job" is not evidence it passes.

Then, per row:

- **Known flicker** (an issue key) — understood, does not block. Nothing to do.
- **Intermittent, no issue** — an unknown flicker: it needs an issue before the release, so that the
  next triage recognises it. Propose one; see the flickering-issue fields in [[jira]].
- **Systematic** — a real breakage. Go to step 4.

Entries under "Not test methods" are a module's whole setup failing, or forbidden content in the
logs. They hide every test of that module, so treat one as more serious than a single failure.

## 4. Root-cause each systematic failure

The `--compare` columns say where the test is healthy; the diff between there and here says why:

```bash
git diff origin/<branch> origin/master -- <module>          # what the healthy branch has that this one lacks
git log -S"<the missing symbol or dependency>" --oneline origin/master -- <module>
```

Passing elsewhere does **not** imply the fix was skipped deliberately — it is often incidental (a
dependency another test happened to add). Check every maintained branch, not only the two in the
policy: a fix that never reached one of them is a finding of its own.

Then classify: **test-only** (the product is fine — the test cannot run as written) or **product**.
Only the second can block a release; say which one it is, with the evidence.

## 5. Report and ask

One table — test, verdict, known/unknown, where else it fails, and for each systematic failure the
cause and whether it is test-only or product. Then state plainly whether anything blocks the
release, and ask what to do. Hand off from there: `xwiki-fix-flickering-docker-test` to stabilise a
flicker, `xwiki-jira` to file an unknown one, `xwiki-backport` for a fix missing from a branch.
