---
title: Change Requests on the xwiki.org wikis
stability: durable
summary: What a Change Request can carry and refuse, how a file change is created, revised and read
  back before the merge, what has to be verified after it, and the per-wiki configuration that decides
  who may review it. The recommended way to propose a documentation page change on xwiki.org.
sources:
  - https://github.com/xwiki/application-changerequest
  - https://extensions.xwiki.org/xwiki/bin/view/Extension/Change%20Request%20Application/
provenance: measured
last-confirmed: 2026-11-13
related: [servers/index.md, conventions/documentation.md, conventions/documentation-migration.md,
  conventions/page-deletion.md]
---

# Change Requests on the xwiki.org wikis

A Change Request (CR) is the recommended save mode for anything but a typo on the xwiki.org
documentation ([[documentation]]). It is a contrib application, **not** core, and it has **no REST
API**: everything below goes through its own `/changerequest/<wiki>/<action>/<crId>` form endpoints,
read out of a page's edit form. Server access, Basic auth and the CSRF rules: [[index]].

Most of the failures here are silent and point the wrong way — they read as a rights problem, a
login problem or "the write did not work" — which is why they are worth knowing before the first
post rather than after a merge.

## What a CR can and cannot carry

- **One wiki.** The application is installed per wiki and its endpoints are wiki-scoped, so a change
  touching both `www` (wiki id `xwiki`) and `extensions.xwiki.org` (`extensions`) needs **two CRs**.
  State the merge order in each description and link the companion. `docReference` carries the wiki
  prefix, and the file-change page name is the serialized reference, which starts with that wiki's
  name and length (`10:extensions…`, not `5:xwiki…`).
- **Not a page carrying `XWiki.XWikiPreferences`.** `addchanges` answers **HTTP 500** whose root
  cause is *"is not allowed to edit the document … through a change request"* — a rights decision on
  a space-admin document, not a malformed payload. This bites navigation pinning, because the pin
  lives on the parent space's `WebPreferences`: a new one, or one carrying only
  `XWiki.PinnedChildPagesClass`, goes in fine, while an established tree root's usually also carries
  `XWikiPreferences` and is refused. Check `…/objects?media=json` on the target before planning a pin
  into a CR; otherwise ask an admin to save it directly.
- **Attachments, including for a page that does not exist yet** — so a converted page and its
  screenshots travel together. The save path only ever *adds* (`readFromForm` →
  `readTemporaryUploadedFiles` → `attachTemporaryAttachmentsInDocument`, fed by the `uploadedFiles`
  request parameter), and the application has **no attachment handler**: **an attachment cannot be
  removed from a file change again.** The ways out are recreating the CR, or merging and then using
  the core `delattachment` on the published page. Decide before uploading.
- **Pages another open CR creates.** A red `wikicreatelink` in the preview is harmless when this CR
  creates that page and a shipped red link when another CR does — and the two look identical. Map
  each red href back to a reference and check it against this CR's own `changedDocuments`
  (`'|'`-separated, on `ChangeRequest.Data.<crId>.WebHome`).

## Creating and revising a file change

- **A first file change must NOT carry `fromchangerequest=1`.** With the flag set for a page the CR
  does not yet carry, `addchanges` answers `HTTP 500 — Failed to handle Resource Reference [type =
  [changerequest]]`, with no hint that the flag is the cause.
- **A second file change of the same page MUST carry it.** Without it the handler starts from the
  *published* document, so it either answers `409 Conflict found in the changes` or silently drops
  what the first file change proposed. It also needs `previousVersion` — the **document** version
  (`4.1`), never the `filechange-4.1` form — which can be read off the CR's own
  `ChangeRequest.Code.FileChangeClass` object when the editor form is unavailable; `form_token` is
  then the view page's `data-xwiki-form-token`.
- **The CR edit form answers HTTP 423 on a page whose required rights the editor refuses** —
  typically a wiki macro with `{{velocity}}` and no `XWiki.RequiredRightClass`
  ([[../architecture/required-rights]]). Its "Force editing" link makes the forcer the content author
  and re-authorises those scripts under their rights: that is the merger's decision, not the
  contributor's. Take the two values from the objects instead, as above.
- **Build content from the page's REST `content`, not from the wiki editor's textarea**, whose body
  starts with **one extra newline**. Posted, that newline becomes a real first line of the page; it
  survives every offline check because the checkers read REST. Strip one leading newline from
  anything scraped from a textarea before comparing it, too.
- **Replacing an attachment needs the CR edit form's token.** Uploading the temporary attachment with
  the ordinary wiki-editor token reports `uploaded`, bumps the attachment version and keeps the
  **old bytes**. Order: read the CR edit form state, upload with that token, then post with it.
- **A published CR answers HTTP 412** (*"already closed or published"*) on `addchanges`. A plan to add
  files to an existing CR can expire between sessions, and that status code is the only symptom.

## The description

`create` and `addchanges` both ignore `crDescription`; only `crTitle` lands. The description is the
**content of `ChangeRequest.Data.<crId>.WebHome`**, and it is editable at any time: POST `form_token`
+ `content` (+ `content_syntax=xwiki/2.1`) to `/changerequest/<wiki>/save/<crId>`, with the token taken
from the `?edit=description` form's **action URL**. `SaveChangeRequestHandler` sets the title only for
`changeType=settitle` and the description for anything else, and touches nothing else.

Two traps: **never send `RequiresHTMLConversion=content`** even though the sheet's form carries it (it
runs the payload through the WYSIWYG HTML conversion, which mangles wiki syntax — the same textarea
also scrapes back as a whole `<!doctype html>` document), and the `ChangeRequestClass` xobject's
`description` property **stays empty on success**, so confirm by reading the page's `content`.
Saving that page as an ordinary wiki document instead is the risky route everyone reaches for: `status`
and `changedDocuments` live on the same xobject and a form replay clobbers the CR's bookkeeping.

## Reading what a CR proposes, before the merge

Each file change is an XML **attachment** `filechange-<version>-<hash>.xml` on
`ChangeRequest.Data.<crId>.<serialized target reference>` — the full `XWikiDocument.toXML` of the
proposed document: `<content>`, `<title>`, every xobject, each attachment's own bytes in base64, and a
`<renderedcontent>` holding the wiki's own rendering of the proposal.

- **REST reports a complete CR as empty.** The file-change pages are *hidden*, so the space listing
  returns only `WebHome` and the attachment list comes back `[]`. With a logged-in session, the route
  that always works is the XAR export
  `/bin/export/XWiki/XWikiPreferences?format=xar&pages=<wiki>:ChangeRequest.Data.<crId>.%`. A **rebase**
  also empties that attachment listing; take the names from the `FileChangeClass` objects.
- **It is XAR format, not REST format**: `<property type="LargeString"><faq>…</faq></property>`, the
  value tag named after the property; a `…List` property nests `<value>` children; values sit after
  the **last** `</class>` (the class definition repeats every property name); an empty content
  serializes as `<content/>`. A REST-shaped parser reports every field as a mismatch, which looks
  exactly like a failed submission.
- **Never count strings in the CR page's diff HTML.** It is a *word-level* diff loaded
  asynchronously, so the initial HTML contains zero occurrences of a class name, all but one diff is
  collapsed, and a changed line arrives with markup between its characters. The CR's own edit form
  serves the latest file change's content and is the cheap read when only content matters.
- **`<renderedcontent>` renders in the CR's document context, not the target's.** Three artifacts
  there are expected and must not be "fixed": `{{plantuml}}` always fails (*EntityReference … is
  null* — it needs a document to store its image on), a **relative** reference resolves against the
  wrong space, and a cross-wiki link renders relative. Reading it takes three steps in this order:
  unescape the XML, strip the HTML tags, unescape the entities — doing them in any other order
  deletes correct content and makes code cells look empty.
- Because PlantUML *always* fails there, a checker that files it under "expected" also reports nothing
  when the diagram source is genuinely broken. Validate the source separately with
  `plantuml -syntax` (which reads STDIN) **and** a PNG render.

## Verifying, before and after the merge

- **Read the highest-numbered file change, not the one you posted.** A review round adds a file change
  rather than replacing one, and a later file change can silently revert a field an earlier one
  emptied — seen on a published CR that shipped its content and not its cleared field. "Unchanged"
  and "cleared" look the same in a diff that renders nothing for an empty value.
- **A second file change on a page nobody revised is a signal.** `FileChangeClass` carries `author`,
  `creationDate`, `minorChange` and `previousVersion`; a browser edit inside the request adds one,
  because the form re-posts the live field values.
- **Verify a replaced image by its md5**, never by its name or version: decode `<attachment><content>`
  out of the file-change XML and hash it.
- **After the merge, read the live page** and diff it against the intended state. It is the only check
  that covers the merge dropping a value, and the only one that catches a reference that resolves to
  the wrong page — that one survives every pre-merge check.

## Configuration is per wiki — read it, never assume it

`ChangeRequest.Code.Configuration` (xobject `ChangeRequest.Code.ConfigurationClass`) is readable
anonymously over REST per wiki. **Re-read it before planning a CR around it**: `preventAuthorsToReview`
was 1 on extensions.xwiki.org and 0 on www in August 2026, and 0 on both in November. A CR can also
deadlock where its `ChangeRequest.Code.ApproversClass` `usersApprovers` names only the author while
`acceptOnlyAllowedApprovers=1` — nobody else may approve, so the list has to be edited or an admin has
to merge. Not every CR pins one.

## Finding the CRs on a page, and reading a rival proposal

`/rest/wikis/query?q=class:ChangeRequest.Code.ChangeRequestClass&type=solr&number=500` lists every CR
on the wiki and **honours field syntax**; `/rest/wikis/<wiki>/spaces/…/search?q=` does **not** — it
ignores it and returns the requested `number` of unrelated hits, so it can never prove a negative. A
page's own `?viewer=cr` tab renders asynchronously, so absence there proves nothing. Some index entries
are stale CRs whose pages 404.

Before reviewing or editing a page, **diff the open CR's proposed content against live**: if it already
fixes the defect, reporting it is noise; if its version is byte-identical to live, merging it after
yours silently reverts you.

## Review comments

The comment form is built by JavaScript and does not exist in the page source. Messages are posted to
`<base>/discussions/wiki/<wiki>/create/Message/<url-encoded discussionReference>` with the CR id and
redirection in `storeConfiguration_*` parameters, and — again — **without `RequiresHTMLConversion`**.
A posted message can be rewritten in place although the UI offers no edit button: it is a hidden page
`ChangeRequest.Data.<crId>.Discussions.Message.<uuid>` carrying `Discussions.Code.MessageClass`, whose
`content` property a REST PUT rewrites and whose `replyTo` says which comment a reply belongs to.

One markup trap, because a mangled comment is public before you see it: **`**1. ` at the start of a
line is a nested list, not bold** — XWiki 2.1 reads `**` as a second-level bullet. Number points `(1)`
and let no line start with `*` ([[../conventions/documentation]] for the rest of the syntax traps).

## Conflicts: the base never moves on its own

A file change keeps **the published version it was created against**: `AddChangesChangeRequestHandler`
copies `previousPublishedVersion` from the previous file change of the same page, so re-posting never
moves the base. When the published page moves meanwhile the CR goes outdated, and once both sides
touched the same lines it reports conflicts and refuses to publish — the normal state of a CR that
rewrites a whole page.

Neither button helps: **Rebase** merges first and throws *"Cannot perform a rebase due to conflicts"*
(harmless — it throws before saving, so try it first), and **Fix conflict** is dead on xwiki.org (its
livetable builds a URL with no base, and `ConflictResolutionChoice` has no handler). The way out is
three supported posts: propose the **published** content and object values, so the three-way merge has
nothing to conflict about; `rebase`, which now succeeds and moves the base; then propose the real
content again. The base version is invisible on the CR page — it is `filechange_documentVersion` in the
file-change livetable; `previousVersion` in the edit form is the *file change* version, not the base.
