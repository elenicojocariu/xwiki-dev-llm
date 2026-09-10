---
name: xwiki-release-documentation
description: "EXPLICIT INVOCATION ONLY. Audit the documentation of fixed XWiki issues — for a whole release (every issue the developer fixed in a Fix Version) or for one named issue — and close the gaps: decide, from the actual diff, whether the change needs a documentation page and/or a release-note entry, write them, and fill the issue's `Documentation` and `Documentation in Release Notes` JIRA fields with the resulting URLs. Release-note entries are created through the Release Notes Application REST endpoints. Use ONLY when the developer names it — `/xwiki-release-documentation`, \"document my fixed issues for 18.8.0\", \"run the release documentation sweep\", \"document XWIKI-24710 for the release\". Do NOT use it for \"write docs for this\" or \"document this page\" — those are xwiki-doc-writing. For the prose of a page use xwiki-doc-writing; to migrate an old page use xwiki-doc-convert; for JIRA reads/writes use xwiki-jira; for wiki reads/writes use xwiki-rest-api; for a contrib extension release announcement use xwiki-contrib-release-blog-post."
---

# XWiki release documentation

**This skill is opt-in.** It is never the answer to "document this" — that is `xwiki-doc-writing`.
It runs only when the developer names it, because it reads the full diff of every issue in scope,
writes to xwiki.org and writes back to JIRA.

What it produces, per fixed issue: a **documentation verdict** and a **release-note verdict**, each
either a URL or `N/A`, each *proven* from the change itself, and each written into the issue's JIRA
field once the artefact it points at actually exists.

The declarative half — the release-note data model, the REST contract, the two JIRA field ids and
the `N/A` rule — is `okf/processes/release-notes.md`. **Read it before running this skill.** The
issue-field conventions are in `okf/servers/jira.md`; the xwiki.org REST access rules
(Cloudflare User-Agent, `/xwiki/rest`, `~/.xwiki-credentials`) are in `okf/servers/index.md`.

## 0. Two modes

```
SWEEP    /xwiki-release-documentation 18.8.0
         "document my fixed issues for 18.8.0"
         → every issue the developer fixed in that Fix Version

SINGLE   /xwiki-release-documentation XWIKI-24710
         "document XWIKI-24710 for the release"
         → that one issue, whatever its assignee
```

They are the same procedure over a different issue set. SINGLE skips the triage-table approval of
§4 (there is one row; show it and get the same approval inline) and keeps every gate of §5 and the
verification of §7. Everything else — the evidence rigor, the `N/A` proof, the field rules — is
identical. A sweep that turns out to hold one issue is still a sweep.

## 1. Resolve the inputs

**The issue set.**

- SWEEP: `fixVersion = <version> AND assignee = currentUser() AND resolution = Fixed`.
  A version-scoped query naturally crosses `XWIKI`, `XCOMMONS` and `XRENDERING` — that is expected.
  Any *other* project key in the result is **reported, not processed**.
  The developer may widen the query (another assignee, `resolution in (Fixed, Done)`) if they say
  so; do not widen it on your own.
- SINGLE: the issue key given. Read its Fix Version to get the version.

**The version.** Accept any spelling — `18.8.0`, `18.8.0RC1`, `18.8.0-rc-1` — and resolve it to the
one JIRA version name:

```
GET https://jira.xwiki.org/rest/api/2/project/XWIKI/versions
```

(The three core projects each carry their own version objects under the same name, and JQL matches
a Fix Version by name across them, so resolving against `XWIKI` is enough.)

**If more than one version matches what was typed, list the matches and ask. Never guess** —
`18.8.0` and `18.8.0-rc-1` are different release notes, and picking the wrong one puts the entries
where nobody will read them.

The Fix Version is also the version the entries are stored against: for a `.0` cycle that is the RC
(`18.8.0-rc-1`), and the final release note aggregates them. Do not "helpfully" retarget to the
final version.

**The release note.** One call says whether it exists and, if so, the page it lives in:

```
GET https://www.xwiki.org/xwiki/rest/wikis/xwiki/releasenotes?product=XWiki
```

Match on the `version` field (the long dashed form). Missing is the normal case for a cycle in
progress — see §6.2.

**The clones.** `xwiki-platform`, `xwiki-commons` and `xwiki-rendering` are needed to read diffs.
Discover them as siblings of the working directory; ask once if any is absent. **Never hardcode a
path** — this plugin ships to other developers' machines. Record what was found in the plan file.

**The code ref**, per repo:

```
ref = the release tag        (xwiki-platform-18.8.0-rc-1)  if it exists
    | origin/master                                        for the cycle in progress
    | origin/stable-X.Y.x                                  for a bugfix line

commits(KEY) = git log --grep=<KEY> <previous-release-tag>..<ref>
```

`git log --all --grep=KEY` is **not** a usable commit set: it returns the master commit, the
backports to every stable branch, the topic branch and the PR-merge duplicate — eight commits for
one fix. The range above drops all of that.

State the known limitation in the report: for a version that has not been released there is no tag,
so the claims below are verified against a moving `origin/master` and can drift before release.

**The plan file**, created now and updated as work completes:

```
<work>/<repo>/<YYYY-MM-DD>-<ShortVersion>-release-documentation/plan.md
```

(`<work>` is the work directory named in the org instructions.) It holds the resolved version, the
clone paths, the ref per repo, and one section per issue with its verdicts, its evidence and its
state. **The run is resumable from this file**: re-invoked, re-read it and continue rather than
redoing what is marked done. Tell the developer the path once.

## 2. Ground rules

These are the bar the developer set, and they are what makes the output worth trusting.

- **Read the full diff of every issue — including the ones heading for `N/A`.** An `N/A` verdict is
  a claim that nothing user-visible or API-visible changed. It has to be *proven* from the diff, not
  assumed from the issue type.
- **Every factual claim** written into a page or an entry — a signature, a property name, a default
  value, a configuration key, a syntax, a UI label — traces to `file:line` **at the code ref**. If
  it cannot be traced, it does not get written.
- **The verifier is not the writer.** Prose is checked by a fresh subagent that did not write it,
  against the source. A claim that contradicts the source is rewritten; a claim that cannot be
  verified is **dropped**, not softened.
- **An existing field value is re-derived, never trusted.** The developer's instruction: *even if a
  field says `N/A`, do not trust it — check whether that is correct.* This is a full audit, not a
  gap-filler. Any disagreement between an existing value and the verdict becomes a flagged row.
- **Nothing non-empty is overwritten without the developer's say-so** (§5).

## 3. Phase 1 — evidence

One **read-only subagent per issue** (or per proposed group), in parallel. Each is given the issue
key, the repo, the ref and the commit range, and returns a structured verdict — never the diff
itself, which must stay out of the main context:

```
issue        : XWIKI-24710
type         : Improvement          component(s): Live Data
commits      : <sha> …
user-visible : yes|no   — what a user or admin would notice, in one line
api-visible  : yes|no   — public API added/changed/removed, with the signature and file:line
config       : any new/changed configuration key, with file:line
facts        : the claims a doc page or an entry would need, each with file:line
images       : the before/after attachments already on the issue (okf/servers/jira.md requires them)
existing     : the current values of customfield_10270 / customfield_10273
verdict      : doc = yes|no  ·  rn = yes|no  ·  why, in one sentence each
```

Candidate target pages are looked up by **Solr search over the four wikis** (`www`, `extensions`,
`dev`, `rendering`) via REST — see `xwiki-rest-api` — and the best candidate is carried into the
triage table for approval.

## 4. Triage

Default by issue type, **overridden by the evidence**. The two verdicts are independent — "no
documentation page fits this" does not cancel the release-note entry.

```
Bug           → N/A , N/A     unless user-visible behaviour or public API changed → RN entry
Improvement   → doc? , RN
New Feature   → doc  , RN
Task          → N/A , N/A     unless it changes a dev practice → dev.xwiki.org doc, RN N/A
```

**Grouping** is proposed here, both directions, and approved by the developer:

- *N issues → 1 entry* when they are one story to a reader (four issues that together made the build
  reproducible). Every issue in the group gets the **same** entry URL.
- *1 issue → N entries* when one fix delivered two unrelated user-visible things. Both URLs,
  space-separated.

Show the table and **get approval before anything is written**:

```
issue          type         doc verdict                      rn verdict     flags
XWIKI-24710    Improvement  update  documentation/…/LiveData  entry          —
XWIKI-24762    Bug          N/A (internal refactor, proven)   entry          field says N/A
XCOMMONS-3752  Task         N/A                               N/A            —
```

## 5. Gates

- **Creating a documentation page has two gates.** Placement is a different decision from prose:

  ```
  GATE 1  Diataxis type · audience · parent location · page name · title   → approve
  GATE 2  the prose                                                        → approve
  ```

  Updating an existing page keeps the single content gate.

- **Category and importance are always put to the developer**, per entry. Category because the
  existing vocabulary must win over the JIRA component spelling (`Blocknote` ≠ `BlockNote`,
  `LiveData` ≠ `Live Data`) and a new value must be proposed rather than invented; importance
  because a non-zero one is an editorial claim and must be justified in the plan. `audience` and
  `screenshots` are derived without asking.

- **Existing state** — never silently overwritten:

  ```
  field = N/A, verdict = needs an entry     → FLAG, propose  N/A → <url>
  field = <url>, the URL 404s               → FLAG broken link
  field = <url> that covers the change      → OK, leave it alone
  an entry already covers the change        → reuse and link it, never duplicate
  a doc page already covers the change      → no edit
  ```

- **Creating a missing release note is confirmed explicitly** (§6.2).

## 6. Phase 2 — execute, one issue at a time

Resumable: each issue is marked done in the plan file as its last step completes. **Writes happen in
the main session, never in a subagent.**

### 6.1 Documentation

Route by where the subject is already documented. **Update in place wherever the page lives; create
only in the new tree.**

```
page in the new /documentation tree     → update            (xwiki-doc-writing)
page in the OLD /Documentation space    → update in place + flag migration candidate
page on extensions.xwiki.org            → update in place + flag migration candidate
page on dev.xwiki.org                   → update in place   (narrower mandate, below)
page on rendering.xwiki.org             → update in place
nothing covers it                       → create, in /documentation only
```

**Migration is never a side effect.** A legacy page that ought to move into the new tree is
*recorded* as a candidate for a later `xwiki-doc-convert` run — converting it inside a
documentation sweep buries a large refactor inside an unrelated change.

**dev.xwiki.org has no written conventions** — no skill and no OKF file governs writing there. Edit
it under a narrower mandate: **additive only** (extend a section, never restructure), mirror the
page's own structure and voice, and do **not** apply Diataxis re-typing. The claim-verification pass
of §2 still applies in full. Record in the report that dev.xwiki.org's conventions are unwritten, as
an `xwiki-knowledge` EXTEND candidate.

Everything else about the prose — Diataxis type, titles, page structure fields, style, versioning —
is `xwiki-doc-writing`'s. Delegate to it rather than restating it.

### 6.2 The release-note entry

All writes go through the **Release Notes Application REST endpoints**; the contract, the
representations and the traps are in `okf/processes/release-notes.md`. Never create an entry page by
generic page creation: an entry needs two objects and an `Entry###` number allocated without racing
another author.

1. **List what is already there** before writing anything — the endpoint does not deduplicate, so a
   re-run without this step doubles every entry:

   ```
   GET /xwiki/rest/wikis/xwiki/releasenotes/XWiki/<version>/changes?limit=200
   ```

   An entry that already covers the change is reused, not duplicated (§5).

2. **If the release note does not exist**, say so, show exactly what will be created, and create it
   **only on confirmation**:

   ```
   POST /xwiki/rest/wikis/xwiki/releasenotes
   {"product": "XWiki", "version": "<the JIRA version name>", "released": false}
   ```

   A `409` means somebody created it in between — re-read the list and carry on. Report what the
   template does *not* fill and what is therefore **left for the release manager**: the introductory
   paragraph, the security-severity sentence, `{{language codes="…"/}}`, and the
   `ReleaseNotes.BackwardCompatibility` object holding the Revapi XML.

3. **Post the entry**:

   ```
   POST /xwiki/rest/wikis/xwiki/releasenotes/XWiki/<version>/changes
   {"title": …, "summary": …, "audience": …, "importance": …, "category": …, "screenshots": […]}
   ```

   - `title` — a **user-facing rephrasing**, not the JIRA summary verbatim.
   - `summary` — XWiki syntax, one to three short paragraphs, with the documentation link woven into
     the prose as an interwiki link.
   - `description` — omit it; it is empty in every recent entry.
   - No JIRA key inside the entry.
   - `importance` is `low` / `medium` / `high` over REST, not the stored `0` / `1` / `2`.
   - `screenshots` names must already be attached to the entry page — so attach the issue's
     before/after images to the created page first, then set the names; a name containing a comma
     cannot be stored.

   **Read the URL back out of the response**, never construct it from an assumed entry number: the
   response carries the stored value, and `reference` is the page that was actually allocated.

### 6.3 The JIRA fields

Only once the artefacts exist. `Documentation` = `customfield_10270`, `Documentation in Release
Notes` = `customfield_10273`; write them over REST (`xwiki-jira`).

- Absolute URLs; several are space-separated.
- Nothing to write → exactly **`N/A`**, with no parenthetical. The reason goes in the run report and,
  if it is worth keeping, a JIRA comment. This changes current team habit (`N/A (internal class)`)
  and it is deliberate: `= "N/A"` is what makes the field queryable.
- **Never an anchor** — it is derived from the entry title and breaks when the entry is retitled.

## 7. Verification and the report

A final pass **re-reads every page and field touched** and confirms every URL resolves. Then:

```
XWIKI-24710    doc ✓   entry ✓   jira ✓
XWIKI-24762    doc –   entry ✓   jira ✓
XCOMMONS-3752  doc ✓   entry ✗ 403   → jira NOT touched

verify pass              : 14 URLs, 14 resolve
flagged                  : 3   (listed, with what disagreed)
migration candidates     : 2   (for a later xwiki-doc-convert run)
left for release manager : intro paragraph, Revapi object
code ref caveat          : verified against origin/master (18.8.0-rc-1 is not tagged yet)
```

## 8. Failure policy

Per-issue transaction. A failure **stops that issue**, records the error and exactly what had
already been written, and the run moves to the next one. The invariant that must not break:

> **JIRA is never pointed at a URL that was not created.**

So the order within an issue is always: write the artefact → read its URL back from the response →
write the field. A partially-done issue stays marked partial in the plan file, with what remains.

## 9. Scope

Core only: `XWIKI`, `XCOMMONS`, `XRENDERING`, `product = XWiki`. But **product and release-note
location are parameters, not constants** in everything above, so an xwiki-contrib extension release
can reuse the machinery later. Contrib is out of scope today — for announcing a contrib release use
`xwiki-contrib-release-blog-post`.
