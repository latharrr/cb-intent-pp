# PicaPool Commute — tracked intent form

The 9-step commute intent form, wired up per `PLAYBOOK.md`: a Google Sheet
is the database, Apps Script is the API, Vercel serves one static file.

| File | What it is |
|---|---|
| `index.html` | The deployable page. Original form + an additive tracking layer at the bottom of its `<script>`. |
| `picapool-commute-1.html` | The untouched original, kept as the reference. Not deployed. |
| `apps-script/Code.gs` | The whole backend. Paste into the Sheet's Apps Script editor. |
| `vercel.json` | Rewrites every path to `index.html`, so `/srcc` is a trackable slug with no server. |
| `test/smoke.js` | Headless run of the whole page — walks all 9 steps and asserts every beacon. |

Frontend `BUILD` is `2026-09-10-c`. Backend `CODE_VERSION` is `2026-09-10-a`.

---

## Step 0 inventory (what the tracking layer was derived from)

| Question | Answer for this page |
|---|---|
| Screens | 9, routed by `state.step` + `goto()`/`render()`. Resume works. |
| Identity | `full_name` + `phone_number` (required), `college` (required), `email_optional`. |
| Complete | reaching step 9 — page 8's interest answer submits. |
| Repeatable data | **none** — every answer is a single value, so there is no long-format detail tab (playbook 2.3 does not apply). |
| Outbound CTAs | **none on the page today.** Page 9 promises "we'll WhatsApp you" but ships no link. |
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

The frontend is verified headlessly too — 57 checks, all passing:

```bash
npm i --no-save jsdom && node test/smoke.js
```

It boots the real `index.html`, walks all 9 steps, and asserts the payload
of every beacon: slug/`?ref` capture, one stable session id, the partial →
complete transition, resume-where-you-left-off, `?new=1` wiping the
session, CTA injection and click stamping once a link is configured,
`pagehide` forcing a flush, and the whole page still working in a webview
with no `sendBeacon`, no `fetch` and no `localStorage`.

**Housekeeping:** that test left a `SELFTEST` row behind. Remove it with
**PicaPool → Delete self-test row** in the Sheet menu before you read real
numbers.

---

## Finish the Sheet setup

The backend is deployed but the tabs were created by the test POST, not by
setup — so conditional formatting and the Dashboard don't exist yet.

1. Open the Sheet → **Extensions → Apps Script**.
2. Run `setupSheets()` once from the function dropdown (approve permissions).
   That builds `Dashboard`, red/green formatting on `Submissions`, and the
   `Errors` tab.
3. Reload the Sheet — a **PicaPool** menu appears with:
   - *Run self test* — writes a `SELFTEST` row and tells you whether the
     script is broken or nothing is reaching it. Those two look identical
     from the Sheet alone; this is the only thing that separates them.
   - *Rebuild dashboard* — safe to re-run any time.
   - *Delete self-test row*
   - *Run full setup*

The Dashboard is pure formulas, so it is always live — nothing to refresh
on a trigger.

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

## Turning on the CTAs

Three constants at the top of the tracking layer in `index.html`:

```js
var PRIMARY_GROUP_LINK = '';   // WhatsApp/Telegram commute group
var APP_SMART_LINK     = '';   // Instally/Branch link, if PicaPool has one
var ENABLE_INVITE_CTA  = false; // leave false until a referral reward exists
```

Empty = the feature stays off and page 9 renders exactly as it does now.
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
