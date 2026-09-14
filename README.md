# PicaPool Commute — tracked intent form

The 5-step commute intent form, wired up per `PLAYBOOK.md`: a Google Sheet
is the database, Apps Script is the API, Vercel serves one static file.

| File | What it is |
|---|---|
| `index.html` | The deployable page. Original form + an additive tracking layer at the bottom of its `<script>`. |
| `picapool-commute-1.html` | The untouched original, kept as the reference. Not deployed. |
| `apps-script/Code.gs` | The whole backend. Paste into the Sheet's Apps Script editor. |
| `vercel.json` | Rewrites every path to `index.html`, so `/srcc` is a trackable slug with no server. |
| `test/smoke.js` | Headless run of the whole page — walks all 5 steps and asserts every beacon. |
| `test/explode.js` | Unit test for the backend's multi-select explode logic, including the legacy-row recovery path. |

Frontend `BUILD` is `2026-09-10-e`. Backend `CODE_VERSION` is `2026-09-10-b`.

> **The backend is one version behind the frontend right now.** Page 4 went
> multi-select, which added two columns and a whole derived tab — none of
> which exists until `apps-script/Code.gs` is re-pasted and published as a
> **new version**. Until then the live `/exec` still reports
> `expectedColumns: 27` and silently drops `travelModesJSON` /
> `travelModeCount`; the multi-select answer survives only as the joined
> summary string in column M. See **Finish the Sheet setup** below.

---

## Step 0 inventory (what the tracking layer was derived from)

| Question | Answer for this page |
|---|---|
| Screens | 5, routed by `state.step` + `goto()`/`render()`. Resume works. |
| Identity | `full_name` + `phone_number` (required), `college` (required), `email_optional`. |
| Complete | reaching step 5 — page 4's travel-mode selection submits. |
| Repeatable data | **yes, as of the MSDF-HRC-024 refinement** — page 4 is multi-select, so playbook 2.3 applies: raw blob + summary cell on `Submissions`, exploded into a derived `TravelModes` tab. |
| Outbound CTAs | **none on the page today.** Page 5 promises "we'll WhatsApp you" but ships no link. |
| App smart link | none supplied. |
| Referral incentive | none exists, so the referral code is tracked internally with no promise printed on screen. |

---

## What already works, verified live

A real POST chain was run against the deployed `/exec`:

```
submissions: 1   columns: 27 / 27 expected   completed: 1
clientBuilds: { "2026-09-10-b": 1 }   slugs: 2   errors: 0
```

Partial then complete on the same `sessionId` produced **one** row, not two —
the upsert is working. Health check any time by opening the `/exec` URL in a
browser.

The frontend is verified headlessly too — 114 checks, all passing:

```bash
npm i --no-save jsdom && node test/smoke.js
node test/explode.js   # 12 more, no dependencies
```

It boots the real `index.html`, walks all 5 steps, and asserts the payload
of every beacon: slug/`?ref` capture, one stable session id, the partial →
complete transition, resume-where-you-left-off, `?new=1` wiping the
session, CTA injection and click stamping once a link is configured,
`pagehide` forcing a flush, every screen refusing to advance until Next is
pressed, the sound and haptic calls, and the whole page still working in a
webview with no `sendBeacon`, no `fetch`, no `localStorage` and an
`AudioContext` that refuses to construct. Section 11 asserts the
MSDF-HRC-024 spec item by item — the removed stations, the page 4 question
copy, the exact option order, `role="checkbox"`, the box being the *first*
child so it lands on the left, multi-select toggling, the empty-selection
guard, and the 30–180 minute chips.

`test/explode.js` covers the backend explode branches without needing Apps
Script: blob wins over the summary, malformed JSON falls through instead of
throwing, and pre-multi-select rows are recovered from the old single-value
column rather than dropped.

**Housekeeping:** that test left a `SELFTEST` row behind. Remove it with
**PicaPool → Delete self-test row** in the Sheet menu before you read real
numbers.

---

## Finish the Sheet setup

1. Open the Sheet → **Extensions → Apps Script**, and **paste the current
   `apps-script/Code.gs` over what is there** — it is a version behind.
2. Run `setupSheets()` from the function dropdown (approve permissions).
   That appends the two new columns, builds `Dashboard`, `TravelModes`,
   `Errors`, red/green formatting, and installs the hourly refresh trigger.
3. **Deploy → Manage deployments → pencil → Version: New version.** Pasting
   the code does *not* change what `/exec` serves. Confirm by opening the
   `/exec` URL: `codeVersion` should read `2026-09-10-b` and
   `expectedColumns` `29`.
4. Reload the Sheet — a **PicaPool** menu appears with:
   - *Run self test* — writes a `SELFTEST` row and tells you whether the
     script is broken or nothing is reaching it. Those two look identical
     from the Sheet alone; this is the only thing that separates them.
   - *Rebuild dashboard* — safe to re-run any time.
   - *Rebuild TravelModes report*
   - *Backfill old rows into TravelModes* — same rebuild, but it reports how
     many rows it recovered from the pre-multi-select column.
   - *Delete self-test row*
   - *Run full setup*

The Dashboard is pure formulas, so it is always live. `TravelModes` is the
one derived tab, so it refreshes on an hourly trigger *and*
opportunistically after each completion (throttled to once a minute) — a
trigger-only refresh would leave anyone who hasn't re-run setup staring at
a silently stale tab, and stale looks exactly like missing from outside.

## Page 4 is multi-select

One person can now hold several travel modes, which is the case playbook
2.3 exists for. Three things go to the Sheet:

| Where | What |
|---|---|
| `travelMode` (col M) | readable summary, e.g. `Walking, Metro` — in canonical option order, not tap order, so the same set always reads the same |
| `travelModesJSON` (col AB) | the lossless blob |
| `travelModeCount` (col AC) | how many modes |

The blob is exploded into a **`TravelModes`** tab, one row per (person,
mode), with a `source` column marking whether it came from the blob
(`preset`) or was recovered from a pre-multi-select row (`legacy-single`).
That tab is derived — `Submissions` is the source of truth and it gets
wiped and rebuilt wholesale. Never hand-edit it.

`explodeModes()` in `Code.gs` is the twin of `buildSubmissionPayload()` in
`index.html`. **Renaming an option in one means renaming it in the other**,
or the two desync quietly and the tab starts reporting labels the form no
longer offers. That happened once already: `Rapid (Rapido)` became
`Rapido (bike taxi)` on 11 Sep 2026, so rows written before that date carry
the old string. `TRAVEL_MODE_ALIASES` in `Code.gs` maps the old label onto
the new bar so the dashboard keeps counting the history instead of dropping
it to zero. Any future rename belongs in that map too.

The Dashboard counts each mode off that tab rather than matching column M,
because M holds combinations. Bars there sum to more than the number of
people, which is why the section is labelled as overlapping, and a
**Most common mode combinations** table sits under it — the one that
actually matters for pooling people into a shared cab.

## Fitting one screen, without a scroll

Every step is meant to be answerable without scrolling: question, answer
and the Next button all on screen at once. Three things hold that up, and
all three are easy to undo by accident.

1. **`dvh`, not `vh`.** On a phone `100vh` is the height the page *would*
   have with the URL bar hidden, so a `100vh` frame always overflows by the
   height of the browser chrome. `.stage`, `.phone` and `body` each set
   `100vh` first and `100dvh` second — old browsers keep the fallback.
2. **Viewport-relative rhythm.** `--v-lg` / `--v-md` / `--v-sm` in `:root`
   are `clamp(min, Nvh, max)`. On a tall phone they resolve to the original
   fixed values; on a short one they shrink instead of pushing the CTA
   below the fold. Reach for one of those tokens rather than a new hard
   pixel margin. The option rows, the inputs and the page 1 illustration
   are capped the same way.
3. **`.spacer` may not have a height of its own.** It is `flex:1 1 auto;
   min-height:0` — a spring that pushes the CTA down when there *is* room
   and collapses to nothing when there is not. Its old `min-height:24px`
   was the empty mid-page band that shoved Next off the bottom.

`.cta-area` is `position:sticky; bottom:0` as the backstop. On a screen
that genuinely cannot fit — small phone, keyboard open — Next stays pinned
to the bottom edge over a short fade instead of hiding below the fold.

## Deploy the site

```bash
npm i -g vercel
vercel login
vercel --prod
```

Then add the custom domain in the Vercel project settings and point DNS at it.

### Re-deploying after a change
- **Frontend:** bump `BUILD` in `index.html`, push — Vercel redeploys.
- **Backend:** paste the new `Code.gs` over the old one, re-run
  `setupSheets()` (safe, additive only), then **Deploy → Manage deployments
  → pencil → Version: New version**. Pasting code alone does *not* change
  what `/exec` serves.

---

## Tap feel

Every tap plays a short, quiet sine tick and a ~8ms haptic buzz; pressing
Next plays a two-note rise, Back a lower note, and arriving on the
confirmation screen a three-note flourish with a patterned buzz to go with
the confetti. Two constants turn either half off:

```js
var ENABLE_SOUND   = true;
var ENABLE_HAPTICS = true;
```

Both are wrapped in the playbook's 1.11 pattern — lazy construction inside
a `try`, an "unavailable here" flag, every call site guarded — because
in-app WhatsApp and Instagram webviews refuse to construct an
`AudioContext`, and an uncaught error there would kill every line after it,
tracking included. iOS has no Vibration API at all, so haptics are simply a
no-op there rather than an error. The flourish deliberately does *not* play
for someone resuming straight onto step 5: there is no user gesture on that
load, so the browser would block the audio and the buzz would arrive out of
nowhere.

## Auto-advance — off

Every screen waits for a deliberate press of Next. Picking an option or a
chip selects it and nothing else; the screen never moves on by itself.
(Turned off on 11 Sep 2026 on request — it was surprising people mid-tap.)

The wiring is still there, gated by two constants, so it is one edit to
bring back:

```js
var AUTO_ADVANCE       = false;
var AUTO_ADVANCE_CHIPS = false;  // true = a chip tap is also a final answer
```

With them on, screens 7 and 8 advance 320/380ms after an option tap and
screens 5 and 6 advance 900ms after a **chip** tap (long enough for the
"₹120/day is ₹3,120+ every month" insight to land). Page 4 is deliberately
never in that set: it is multi-select, so advancing on the first tap would
make a second mode impossible to pick. Advancing works by pressing the
page's own Next button programmatically, so it reuses that button's
existing validation rather than duplicating it.

---

## Turning on the CTAs

Three constants at the top of the tracking layer in `index.html`:

```js
var PRIMARY_GROUP_LINK = '';   // WhatsApp/Telegram commute group
var APP_SMART_LINK     = '';   // Instally/Branch link, if PicaPool has one
var ENABLE_INVITE_CTA  = false; // leave false until a referral reward exists
```

Empty = the feature stays off and page 5 renders exactly as it does now.
Paste a link in and you get, automatically:

- a tracked button on the confirmation screen,
- a `/wa` (and `/app`) redirect shortlink — `yoursite.com/wa` logs a click
  and bounces straight to the group without ever drawing the form,
- a per-person click timestamp on that user's own row, plus a row in the
  Dashboard's **Engagement links** table.

`ENABLE_INVITE_CTA` is deliberately off: per playbook Step 0 point 7, there
is no reward mechanism behind referrals yet, so the page shouldn't promise
one. Referral codes are still generated and logged in the `Slug` tab.

---

## Trackable links you can hand out today

| Link | What it does |
|---|---|
| `yoursite.com/srcc` | any path is a campaign slug; shows the form, tagged `srcc` |
| `yoursite.com/?ref=AB2CD3` | attributes the signup to that referral code |
| `yoursite.com/?debug=1` | pins a live readout — build, session id, every beacon result |
| `yoursite.com/?new=1` | wipes the local session, for testing on your own phone |

## Debugging

`sendBeacon` throws its response away, so a broken backend is invisible from
the page. In order:

1. Open `/exec` in a browser — row counts, newest submission, build-stamp
   breakdown, last error.
2. `clientBuilds` in that output not showing the current `BUILD` = the page
   never redeployed. No backend change fixes that.
3. `?debug=1` on the page — tells you whether the page is even *trying* to
   POST.
4. The `Errors` tab in the Sheet — every uncaught backend exception.

## One thing to know about this architecture

The `/exec` URL is public by design (the page has to POST to it from the
browser, so it is visible in view-source on any deployment). Anyone who has
it can write rows. That is inherent to the Sheet-as-database pattern and
fine for intent-form data — just don't put anything in this Sheet you
wouldn't be relaxed about someone injecting junk rows into. The `Errors`
tab and the `clientBuild` column are what let you spot rows that didn't
come from the real page.
