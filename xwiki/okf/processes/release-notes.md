---
title: Release notes and the documentation fields of an issue
stability: durable
summary: How a release note is stored by the Release Notes Application (the page it lives in, the
  entries it aggregates), the REST endpoints that create and list them, and the two JIRA fields that
  record where a fixed issue ended up documented. The vocabulary of categories and the current
  versions are volatile — verify recipes are given.
sources:
  - https://github.com/xwiki-contrib/application-releasenotes
  - https://www.xwiki.org/xwiki/bin/view/ReleaseNotes/
  - https://extensions.xwiki.org/xwiki/bin/view/Extension/Release%20Notes%20Application
---

# Release notes and the documentation fields of an issue

Two things are recorded when an issue is fixed: **documentation** (a page somebody can read to learn
the feature) and a **release-note entry** (a line in "New and Noteworthy" telling readers of that
version what changed). They are independent — plenty of changes get one and not the other. The two
JIRA fields below say which of the two happened, and where.

The procedure that fills all of this in is the **`xwiki-release-documentation`** skill; this file is
the declarative half it relies on.

## The two JIRA fields

| Field | Id | Holds |
|---|---|---|
| **Documentation** | `customfield_10270` | the absolute URL of the page documenting the change |
| **Documentation in Release Notes** | `customfield_10273` | the absolute URL of the release-note entry |

Both are plain strings, on `XWIKI`, `XCOMMONS` and `XRENDERING` alike.

Durable rules for their values:

- **When there is nothing to write, the value is exactly `N/A`** — no parenthetical, no sentence.
  The team habit of writing `N/A (internal class)` looks helpful and costs the only thing the field
  is good for: `Documentation = "N/A"` is what makes "find every fixed issue nobody documented"
  a query. The *reason* belongs in a JIRA comment or the run report, not in the field.
- **Several URLs are space-separated** (one issue can produce two entries).
- **Never write an anchor.** `…/18.8.0RC1/#HSomeTitle` is derived from the entry's title, so
  retitling the entry silently breaks every JIRA link pointing at it. Link the entry page itself.
- The two verdicts are independent: `Documentation = N/A` with a real
  `Documentation in Release Notes` URL is a common and correct combination (a behaviour change worth
  announcing that no documentation page describes).

Filtering trap: the **`Documentation` field does not support the `!=` JQL operator** (the search API
answers 400). Use `is not EMPTY` / `is EMPTY`.

## How a release note is stored

The Release Notes Application (`xwiki-contrib/application-releasenotes`, installed on xwiki.org)
stores a release note as a page tree:

```
ReleaseNotes.Data.<Product>.<ShortVersion>.WebHome        ← ReleaseNotes.Code.ReleaseNoteClass
  └── …<ShortVersion>.Entry###.WebHome                    ← EntryClass + Change.ChangeClass
```

- The release-note page carries `ReleaseNotes.Code.ReleaseNoteClass`: `product`, `version`,
  `released`, `date`.
- **The "New and Noteworthy" list is not page content.** The page calls `{{releasenotechanges/}}`,
  which queries its child entry pages. Writing prose into the release-note page does not add an
  entry.
- Each entry page carries **two** objects, and an entry missing either is invisible:
  `ReleaseNotes.Code.EntryClass` (`product`, `version`, `type` = `Change|Contributors`) and
  `ReleaseNotes.Code.Change.ChangeClass` (`title`, `summary`, `description`, `category`, `audience`,
  `importance`, `screenshots`).
- `Entry###` is zero-padded and allocated by scanning the version's existing entries. Two authors
  creating an entry at the same time collide unless the allocation is done by the application —
  which is why entries are created through the REST endpoints below and **never** by generic page
  creation.
- **ShortVersion** is the version uppercased, with `-` stripped and `MILESTONE` replaced by `M`:
  `18.8.0-rc-1` → `18.8.0RC1`, `8.3-milestone-1` → `8.3M1`. Same shape as an `@since` tag. The
  *objects* hold the long, dashed form (`18.8.0-rc-1`); only the page name is short. Prefer reading
  the mapping back from the REST list over recomputing it.
- **A bugfix release note renders a `{{jira}}` issue list instead of the entries**, so its issues
  need no entry.

**Entries belong to the version JIRA names as the Fix Version.** For a `.0` cycle that is the RC
(`18.8.0-rc-1`), and the final release note (`18.8.0`) holds *no* entries of its own — it displays
the RC's through aggregation. Adding entries to the final release note would duplicate them.

## The REST endpoints (since Release Notes Application 2.7)

Four endpoints, under the standard XWiki REST root, all JSON. `<product>` and `<version>` are URL
encoded, and the version is the **long, dashed form** — never the page name.

```
GET  /xwiki/rest/wikis/{wiki}/releasenotes[?product=X]
POST /xwiki/rest/wikis/{wiki}/releasenotes
GET  /xwiki/rest/wikis/{wiki}/releasenotes/{product}/{version}/changes[?…]
POST /xwiki/rest/wikis/{wiki}/releasenotes/{product}/{version}/changes
```

**Release note** — `{product, version, date, released, template, reference}`.
`date` is `yyyy-MM-dd` (a time of day is dropped; `null` when undecided). `template` is read only on
a POST, and defaults to the template configured for the wiki; the template a note was created from is
not kept. `product` may be left out on a POST to use the wiki's configured product. `reference` is
returned only — the page is named after the product and the version.

**Change** — `{title, summary, description, audience, importance, category, screenshots, product,
version, reference}`. `title` is the only required field. `importance` is spelled `low` / `medium` /
`high` over REST (the object stores `0` / `1` / `2`). `audience` is `user` / `administrator` /
`developer`. `screenshots` is a JSON array of attachment names on the entry page — **a name
containing a comma cannot be stored**, since they are stored comma-separated. `product`, `version`
and `reference` are returned only: what the change belongs to is what the URL says, and the entry
page is allocated by the wiki.

Behaviour worth knowing before writing a client:

- **The response body of a POST is the stored value, not the posted one.** A property the request
  leaves out holds whatever the change template gives it — at the time of writing a change posted
  with no `importance` comes back `medium`, because `ChangeTemplate` ships `importance = 1`. Read
  the response rather than assuming the request, and do not hardcode that default: it is a value on
  a template page, not a rule.
- **`POST /releasenotes` on a release note that exists answers `409`**, carrying the page it lives
  in — deliberately not the note itself, since it may be about another product. For a client that
  may be re-running, that 409 on the *first* call is the signal it has run before.
- **`POST …/changes` never deduplicates.** Posting the same change twice creates it twice. A client
  that may be re-running lists the existing changes first.
- **`GET …/changes` on a release note that does not exist answers `200` with an empty list**, not
  `404`. Existence is checked with `GET /releasenotes`, not with the change listing.
- `GET …/changes` returns only the changes stored *against that version*, most important first.
  `aggregated=true` folds in its milestones and release candidates — which is what the release note
  itself displays. Paged with `limit` (100 by default) / `offset`; the answer carries `hasMore`.
  Filters: `audience`, `category`, `importance` (comma-separated, names or numbers),
  `containsScreenshots`.
- `POST …/changes` on a version with no release note answers `404`.
- Failures answer `{message, reference}`: `409` exists, `401` (guest) or `403` (logged in) not
  allowed, `404` no such release note, `400` unusable, `500` wiki failure.

**`reference` → the URL a JIRA field wants.** The returned reference escapes the dots inside a page
name: `ReleaseNotes.Data.XWiki.18\.7\.0RC1.Entry008.WebHome`. Split it on *unescaped* dots, unescape
each segment, drop the trailing `WebHome`:

```
https://www.xwiki.org/xwiki/bin/view/ReleaseNotes/Data/XWiki/18.7.0RC1/Entry008/
```

**What creating a release note over REST does not do.** The endpoint applies the template, which
gives the page its `{{releasenotechanges/}}` call and its structure. It leaves for the release
manager: the introductory paragraph, the security-severity sentence, `{{language codes="…"/}}`, and
the `ReleaseNotes.BackwardCompatibility` object holding the Revapi XML. Say so rather than inventing
them.

## Writing an entry

- **`title` is a user-facing rephrasing, not the JIRA summary.** JIRA summaries are written to a
  developer ("NPE in FooResolver when the reference is nested"); a release note is read by someone
  deciding whether to upgrade.
- **`summary`** is XWiki syntax, one to three short paragraphs: what changed and why it matters,
  with the documentation link woven into the prose as an interwiki link
  (`[[the macro>>doc:extensions:Extension.Foo Macro.WebHome||anchor="HParameters"]]`), the way the
  existing entries do it. Existing summaries run roughly 80–1000 characters.
- **`description` is dead in practice** — it was empty in every one of the 81 entries of the
  18.1→18.8 RC release notes. Leave it out.
- **No JIRA key inside an entry**: the release note lists the issues separately.
- `importance` in practice skews low (of those same 81: 45 low, 32 medium, 4 high). `high` is for a
  headline feature, not for "this one matters to me".
- `audience` follows who the change affects, and decides the section of the release note the entry
  lands in. Developer-facing changes are the largest group.
- `screenshots` are the before/after images the change already owes its JIRA issue (see
  [[../servers/jira]]), re-attached to the entry page.

**Category is a drifting free-text vocabulary, and the existing spelling wins.** The values are
mostly JIRA component names but the two have diverged — the release notes say `Blocknote` where JIRA
says `BlockNote`, `LiveData` where JIRA says `Live Data`. Writing the JIRA spelling silently creates
a near-duplicate value and splits every report. Never invent one silently: match case-insensitively
against what is in use, and propose a genuinely new category rather than creating it.

`verify:` the vocabulary in use — it changes every cycle, so harvest it instead of trusting a list:

```
for v in 18.8.0-rc-1 18.7.0-rc-1 18.6.0-rc-1 18.5.0-rc-1; do
  curl -s -H 'Accept: application/json' \
    "https://www.xwiki.org/xwiki/rest/wikis/xwiki/releasenotes/XWiki/$v/changes?limit=200"
done | python3 -c "import json,sys; [print(c['category']) for l in sys.stdin for c in json.loads(l)['changes']]" | sort -u
```

`verify:` which release notes exist, and their exact version strings:
`GET /xwiki/rest/wikis/xwiki/releasenotes?product=XWiki`.

## Access

xwiki.org REST needs the `/xwiki/rest/…` path (not `/rest/…`), plain `curl`'s User-Agent (a
browser-like one is blocked by Cloudflare) and Basic auth from `~/.xwiki-credentials` for anything
that writes — all in [[../servers/index]]. JIRA over REST with `JIRA_API_TOKEN` as a bearer token is
in [[../servers/jira]].
