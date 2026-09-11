/**
 * PicaPool Commute — Sheet-as-database backend.
 * Built from PLAYBOOK.md Step 2/3 for the 9-step commute intent form.
 *
 * Bumped whenever this file changes meaningfully, reported by doGet(). A
 * Web App deployment serves a PINNED VERSION: pasting new code into the
 * editor does not change what /exec runs until you publish a new version
 * (Deploy > Manage deployments > pencil > Version: New version). Compare
 * this against the file you pasted — if they differ, the live backend is
 * not the code you're reading and nothing you change is having any effect.
 */
const CODE_VERSION = '2026-09-10-b';

const SUBMISSIONS_SHEET = 'Submissions';
const SLUG_SHEET = 'Slug';
const DASHBOARD_SHEET = 'Dashboard';
const ERROR_SHEET = 'Errors';
const TRAVELMODES_SHEET = 'TravelModes';

/* NEVER reorder or insert into this list — handleSubmit writes a row
   positionally from column 1, and getSheet() only ever APPENDS newly-added
   headers at the end. New fields go on the end, or old sheets shift.
   27 columns, i.e. past a new tab's default 26 — every range access below
   goes through ensureGrid() for exactly that reason. */
const SUBMISSION_HEADERS = [
  'sessionId', 'firstSeen', 'lastUpdated', 'status', 'slug', 'referredBy', 'myRefCode',
  'fullName', 'college', 'phone', 'email', 'metroStation', 'travelMode',
  'dailySpend', 'oneWayMinutes', 'commuteFeeling', 'sharedCabInterest',
  'currentScreen', 'screensReached', 'totalScreens', 'device', 'userAgent', 'eventsJSON',
  'groupClickedAt', 'appDownloadClickedAt', 'referralShareClickedAt',
  'clientBuild',
  // appended when page 4 became multi-select. travelMode (col M) keeps the
  // readable summary; these two are the lossless blob and the count.
  'travelModesJSON', 'travelModeCount'
];
const S_SESSION = 1, S_FIRSTSEEN = 2, S_LASTUPDATED = 3, S_STATUS = 4, S_SLUG = 5;

const SLUG_HEADERS = [
  'slug', 'type', 'destinationOrOwner', 'firstSeen', 'lastSeen',
  'visits', 'clicks', 'formStarts', 'formCompletions'
];
const L_SLUG = 1, L_TYPE = 2, L_DEST = 3, L_FIRSTSEEN = 4, L_LASTSEEN = 5,
      L_VISITS = 6, L_CLICKS = 7, L_STARTS = 8, L_COMPLETIONS = 9;

const ERROR_HEADERS = ['at', 'action', 'sessionId', 'message', 'payload'];

/* Page 4 is multi-select, so ONE person can hold several travel modes.
   Cramming that into a single Submissions cell is unqueryable, so per
   PLAYBOOK.md 2.3 it is also exploded into a long-format TravelModes tab:
   one row per (person, mode). That tab is DERIVED — Submissions is the
   source of truth and it is wiped and rebuilt wholesale, never hand-edited.
   It refreshes on an hourly trigger AND opportunistically right after a
   completion (throttled), because a trigger-only refresh leaves anyone who
   hasn't re-run setup looking at a silently stale tab. */
const TRAVELMODES_HEADERS = [
  'sessionId', 'lastUpdated', 'status', 'fullName', 'college', 'phone',
  'metroStation', 'mode', 'source'
];
// mode is column H, which is what the Dashboard breakdown counts against
const REBUILD_THROTTLE_MS = 60 * 1000;

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return textOut('bad json'); }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.action === 'submit') handleSubmit(body);
    else if (body.action === 'track') handleTrack(body);
    else if (body.action === 'createLink') handleCreateLink(body);
  } catch (err) {
    // sendBeacon throws the response away — an uncaught error here is a
    // write that vanishes with nothing to see on either side. Log it.
    logError(err, body);
    return textOut('error: ' + (err && err.message ? err.message : err));
  } finally {
    lock.releaseLock();
  }
  return textOut('ok');
}

/* Open the /exec URL in a browser: counts, newest submission, build-stamp
   breakdown, last error. Beats guessing when "a row doesn't show up". */
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const status = { ok: true, codeVersion: CODE_VERSION, now: new Date() };
  try {
    const sub = ss.getSheetByName(SUBMISSIONS_SHEET);
    status.submissions = sub ? Math.max(0, sub.getLastRow() - 1) : 0;
    status.columns = sub ? sub.getLastColumn() : 0;
    status.expectedColumns = SUBMISSION_HEADERS.length;
    if (sub && sub.getLastRow() > 1) {
      const c = colMap(sub);
      const rows = sub.getRange(2, 1, sub.getLastRow() - 1, sub.getLastColumn()).getValues();
      let newest = null, complete = 0;
      const builds = {};
      rows.forEach(r => {
        const t = c.lastUpdated ? r[c.lastUpdated - 1] : null;
        if (t && (!newest || t > newest)) newest = t;
        const b = c.clientBuild ? (r[c.clientBuild - 1] || '(none)') : '(no column)';
        builds[b] = (builds[b] || 0) + 1;
        if (c.status && r[c.status - 1] === 'complete') complete++;
      });
      status.completed = complete;
      status.clientBuilds = builds; // newest rows not on the current BUILD = the page never redeployed
      status.lastSubmissionAt = newest;
    }
    const slug = ss.getSheetByName(SLUG_SHEET);
    status.slugs = slug ? Math.max(0, slug.getLastRow() - 1) : 0;
    const errs = ss.getSheetByName(ERROR_SHEET);
    status.errors = errs ? Math.max(0, errs.getLastRow() - 1) : 0;
    if (errs && errs.getLastRow() > 1) {
      const last = errs.getRange(errs.getLastRow(), 1, 1, 4).getValues()[0];
      status.lastError = { at: last[0], action: last[1], message: last[3] };
    }
  } catch (err) { status.ok = false; status.message = String((err && err.message) || err); }
  return ContentService.createTextOutput(JSON.stringify(status, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

function textOut(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}
function epochToDate(ms) { return ms ? new Date(Number(ms)) : ''; }

function logError(err, body) {
  try {
    const sh = getSheet(ERROR_SHEET, ERROR_HEADERS);
    ensureGrid(sh, sh.getLastRow() + 1, ERROR_HEADERS.length);
    sh.appendRow([new Date(), (body && body.action) || '', (body && body.sessionId) || '',
      String((err && err.message) || err).slice(0, 500), JSON.stringify(body || {}).slice(0, 2000)]);
  } catch (ignored) { console.error('logError failed', ignored, err); }
}

/* ------------------------------------------------------------------ */
/* Sheet plumbing                                                      */
/* ------------------------------------------------------------------ */

/* A Sheet tab is created 1000 rows x 26 columns and does NOT grow on its
   own: getRange() past those bounds THROWS, it doesn't widen the grid.
   This schema is 27 columns, so without this guard EVERY write would fail
   silently behind a discarded sendBeacon response. Call it before any
   range that could sit outside what the sheet currently has (rows OR
   columns). */
function ensureGrid(sheet, minRows, minCols) {
  const rows = sheet.getMaxRows(), cols = sheet.getMaxColumns();
  if (minCols > cols) sheet.insertColumnsAfter(cols, minCols - cols);
  if (minRows > rows) sheet.insertRowsAfter(rows, minRows - rows);
}

function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    ensureGrid(sh, 2, headers.length);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = sh.getLastColumn();
  const existing = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (!existing[0]) {
    ensureGrid(sh, 2, headers.length);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  // schema grew since this sheet was first set up — append only what's
  // missing, at the end, never touching existing columns or data.
  const missing = headers.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    ensureGrid(sh, 2, existing.length + missing.length);
    sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function findRow(sheet, keyCol, key) {
  const last = sheet.getLastRow();
  if (last < 2 || !key) return -1;
  const values = sheet.getRange(2, keyCol, last - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) { if (values[i][0] === key) return i + 2; }
  return -1;
}

/* header name -> 1-based column, for reading a sheet that getSheet() may
   have appended columns to since this code was last touched. */
function colMap(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return map;
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

function handleSubmit(body) {
  const sh = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  const row = findRow(sh, S_SESSION, body.sessionId);
  const now = new Date();
  const firstSeen = row > 0 ? sh.getRange(row, S_FIRSTSEEN).getValue() : now;

  // same fields, same order as SUBMISSION_HEADERS and as the frontend's
  // buildSubmissionPayload() — the three must be edited together.
  const rowData = [
    body.sessionId, firstSeen, now, body.status || 'partial',
    body.slug || '', body.referredBy || '', body.myRefCode || '',
    body.fullName || '', body.college || '', body.phone || '', body.email || '',
    body.metroStation || '', body.travelMode || '',
    body.dailySpend === '' || body.dailySpend == null ? '' : Number(body.dailySpend),
    body.oneWayMinutes === '' || body.oneWayMinutes == null ? '' : Number(body.oneWayMinutes),
    body.commuteFeeling || '', body.sharedCabInterest || '',
    body.currentScreen || '', body.screensReached || '', body.totalScreens || '',
    body.device || '', String(body.userAgent || '').slice(0, 500),
    String(body.eventsJSON || '').slice(0, 40000),
    epochToDate(body.groupClickedAt), epochToDate(body.appDownloadClickedAt),
    epochToDate(body.referralShareClickedAt),
    body.clientBuild || '(pre-build-stamp)',
    String(body.travelModesJSON || ''),
    body.travelModeCount === '' || body.travelModeCount == null ? '' : Number(body.travelModeCount)
  ];

  const wasComplete = row > 0 && sh.getRange(row, S_STATUS).getValue() === 'complete';
  if (row > 0) {
    ensureGrid(sh, row, rowData.length);
    sh.getRange(row, 1, 1, rowData.length).setValues([rowData]);
  } else {
    ensureGrid(sh, sh.getLastRow() + 1, rowData.length);
    sh.appendRow(rowData);
  }
  if (body.status === 'complete' && !wasComplete) {
    bumpSlugCounter(body.slug, L_COMPLETIONS);
    maybeRebuildTravelModes();
  }
}

/* ------------------------------------------------------------------ */
/* TravelModes — the derived long-format tab (PLAYBOOK 2.3)            */
/* ------------------------------------------------------------------ */

/* The JS twin of this lives in index.html's buildSubmissionPayload():
   state.data.travel_modes (an array of TRAVEL_MODES labels) becomes
   travelModesJSON. Rename an option there and this must follow, or the two
   quietly desync and the tab starts reporting labels the form no longer
   uses. */
function explodeModes(row, c) {
  const out = [];
  const raw = c.travelModesJSON ? String(row[c.travelModesJSON - 1] || '') : '';
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach(m => { if (m) out.push({ mode: String(m), source: 'preset' }); });
        return out;
      }
    } catch (err) { /* fall through and recover from the legacy column */ }
  }
  // Rows captured before page 4 went multi-select only carry the single
  // travelMode string. Recover them from that rather than dropping them —
  // this is the backfill path, and it is why no separate migration is needed.
  const legacy = c.travelMode ? String(row[c.travelMode - 1] || '') : '';
  if (legacy) {
    legacy.split(',').forEach(m => {
      const v = m.trim();
      if (v) out.push({ mode: v, source: 'legacy-single' });
    });
  }
  return out;
}

function rebuildTravelModes() {
  const sub = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  const sh = getSheet(TRAVELMODES_SHEET, TRAVELMODES_HEADERS);
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent();
  }
  if (sub.getLastRow() < 2) return { rows: 0, legacy: 0 };
  const c = colMap(sub);
  const rows = sub.getRange(2, 1, sub.getLastRow() - 1, sub.getLastColumn()).getValues();
  const out = [];
  let legacy = 0;
  rows.forEach(r => {
    explodeModes(r, c).forEach(m => {
      if (m.source === 'legacy-single') legacy++;
      out.push([
        r[c.sessionId - 1], r[c.lastUpdated - 1], r[c.status - 1],
        r[c.fullName - 1], r[c.college - 1], r[c.phone - 1],
        r[c.metroStation - 1], m.mode, m.source
      ]);
    });
  });
  if (out.length) {
    ensureGrid(sh, out.length + 1, TRAVELMODES_HEADERS.length);
    sh.getRange(2, 1, out.length, TRAVELMODES_HEADERS.length).setValues(out);
  }
  return { rows: out.length, legacy: legacy };
}

/* Rebuilding on every single completion would burn quota, so it is
   throttled — and wrapped, because a derived tab must never be able to
   break the submission that triggered it. */
function maybeRebuildTravelModes() {
  try {
    const props = PropertiesService.getScriptProperties();
    const last = Number(props.getProperty('lastModesRebuild') || 0);
    const now = Date.now();
    if (now - last < REBUILD_THROTTLE_MS) return;
    props.setProperty('lastModesRebuild', String(now));
    rebuildTravelModes();
  } catch (err) { /* deliberately swallowed */ }
}

/* Menu-facing: same rebuild, but it reports how many rows it recovered from
   the pre-multi-select single-value column. */
function backfillTravelModes() {
  const res = rebuildTravelModes();
  const msg = res.rows + ' rows rebuilt, of which ' + res.legacy +
    ' were recovered from the old single-value travelMode column.';
  try { SpreadsheetApp.getUi().alert('TravelModes rebuilt', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function handleTrack(body) {
  if (!body.slug) return;
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, body.slug);
  const now = new Date();
  if (row > 0) {
    const col = body.kind === 'visit' ? L_VISITS : L_CLICKS;
    ensureGrid(sh, row, SLUG_HEADERS.length);
    sh.getRange(row, col).setValue((sh.getRange(row, col).getValue() || 0) + 1);
    sh.getRange(row, L_LASTSEEN).setValue(now);
  } else {
    ensureGrid(sh, sh.getLastRow() + 1, SLUG_HEADERS.length);
    sh.appendRow([body.slug, body.redirectType || 'campaign', body.dest || '', now, now,
      body.kind === 'visit' ? 1 : 0, body.kind === 'click' ? 1 : 0, 0, 0]);
  }
  if (body.kind === 'visit') bumpSlugCounter(body.slug, L_STARTS);
}

function bumpSlugCounter(slug, col) {
  if (!slug) return;
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, slug);
  if (row > 0) {
    ensureGrid(sh, row, SLUG_HEADERS.length);
    sh.getRange(row, col).setValue((sh.getRange(row, col).getValue() || 0) + 1);
  }
}

function handleCreateLink(body) {
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, body.slug);
  const now = new Date();
  if (row < 0) {
    ensureGrid(sh, sh.getLastRow() + 1, SLUG_HEADERS.length);
    sh.appendRow([body.slug, body.type || 'referral', body.owner || '', now, now, 0, 0, 0, 0]);
  } else if (body.owner) {
    sh.getRange(row, L_DEST).setValue(body.owner);
  }
}

function applyConditionalFormatting() {
  const sh = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  ensureGrid(sh, 2001, SUBMISSION_HEADERS.length);
  const range = sh.getRange(2, 1, 2000, SUBMISSION_HEADERS.length);
  const partial = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$D2="partial"').setBackground('#FDE2DD').setRanges([range]).build();
  const complete = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$D2="complete"').setBackground('#DCF4E3').setRanges([range]).build();
  sh.setConditionalFormatRules([partial, complete]);
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

/* Submissions column letters, for the formulas below. These stay valid
   because getSheet() only ever appends new columns at the end.
   A sessionId  B firstSeen  C lastUpdated  D status  E slug  F referredBy
   G myRefCode  H fullName   I college      J phone   K email  L metroStation
   M travelMode N dailySpend O oneWayMinutes P commuteFeeling
   Q sharedCabInterest  R currentScreen  S screensReached  T totalScreens
   U device     V userAgent  W eventsJSON  X groupClickedAt
   Y appDownloadClickedAt    Z referralShareClickedAt      AA clientBuild
   AB travelModesJSON        AC travelModeCount
   M (travelMode) now holds a comma-joined summary like "Walking, Metro",
   which is why the per-mode breakdown counts against the TravelModes tab
   instead of matching M exactly. */
const SUB = 'Submissions!';
const STEP_LABELS = [
  'Intro / pitch', 'Your details', 'Metro station', 'Travel mode', 'Daily spend',
  'Travel time', 'Commute feeling', 'Shared-cab pitch', 'Confirmation'
];
const TRAVEL_MODES = ['Walking', 'Metro', 'Rapido (bike taxi)', 'Personal vehicle', 'Auto/Cab', 'Other'];
/* Labels the form used to write for the same mode. Rows already in the
   sheet keep the old string, so the dashboard counts both and history
   does not silently drop to zero when a label is reworded. */
const TRAVEL_MODE_ALIASES = { 'Rapido (bike taxi)': ['Rapid (Rapido)'] };
const FEELINGS = ['Relaxed', 'Manageable', 'Tired out', 'Draining'];

function buildDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  getSheet(SLUG_SHEET, SLUG_HEADERS);

  let sh = ss.getSheetByName(DASHBOARD_SHEET);
  if (!sh) sh = ss.insertSheet(DASHBOARD_SHEET, 0);
  sh.clear(); sh.clearFormats();
  sh.getCharts().forEach(c => sh.removeChart(c));
  // a prior run may have left merges/banding behind — clear() doesn't
  // remove those, and re-applying over an overlapping range throws.
  if (sh.getMaxRows() > 0 && sh.getMaxColumns() > 0) {
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  }
  sh.getBandings().forEach(b => b.remove());
  sh.setTabColor('#FF7A33'); sh.setHiddenGridlines(true);

  const INK = '#093F3C', ACCENT = '#FF7A33', CREAM = '#F1ECDF', GREEN = '#218836';
  const COLS = 9;
  ensureGrid(sh, 320, COLS);

  let r = 1;
  sh.getRange(r, 1, 1, COLS).merge().setValue('PicaPool Commute — live dashboard')
    .setBackground(ACCENT).setFontColor('#FFFFFF').setFontSize(18).setFontWeight('bold')
    .setVerticalAlignment('middle');
  sh.setRowHeight(r, 44); r++;
  sh.getRange(r, 1, 1, COLS).merge()
    .setFormula('="Rebuilt " & TEXT(NOW(),"d mmm yyyy, HH:mm") & "   ·   every number below is a live formula — reopen the sheet and it is current."')
    .setFontColor('#7A8A88').setFontSize(10);
  r += 2;

  const section = (label) => {
    sh.getRange(r, 1, 1, COLS).merge().setValue(label).setBackground(INK)
      .setFontColor('#FFFFFF').setFontWeight('bold').setVerticalAlignment('middle');
    sh.setRowHeight(r, 26); r++;
  };
  const blank = (h) => { sh.setRowHeight(r, h || 10); r++; };
  const note = (text) => {
    sh.getRange(r, 1, 1, COLS).merge().setValue(text)
      .setFontColor('#7A8A88').setFontSize(10).setFontStyle('italic');
    r++;
  };

  /* three KPI tiles per row: label on top, big number under it */
  const kpiRow = (tiles) => {
    tiles.forEach((t, i) => {
      const c = 1 + i * 3;
      sh.getRange(r, c, 1, 3).merge().setValue(t[0]).setBackground(CREAM)
        .setFontColor(INK).setFontSize(10).setFontWeight('bold')
        .setHorizontalAlignment('center').setVerticalAlignment('middle');
      const val = sh.getRange(r + 1, c, 1, 3).merge().setFormula('=' + t[1])
        .setBackground('#FFFFFF').setFontColor(t[3] || INK).setFontSize(20).setFontWeight('bold')
        .setHorizontalAlignment('center').setVerticalAlignment('middle')
        .setBorder(true, true, true, true, false, false, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
      if (t[2]) val.setNumberFormat(t[2]);
    });
    sh.setRowHeight(r, 20); sh.setRowHeight(r + 1, 38);
    r += 2;
  };

  const barRow = (label, valueExpr, denomExpr, color, fmt) => {
    sh.getRange(r, 1).setValue(label).setFontWeight('bold').setFontSize(10);
    const v = sh.getRange(r, 8, 1, 2).merge().setFormula('=' + valueExpr)
      .setFontWeight('bold').setFontColor(color).setHorizontalAlignment('right');
    if (fmt) v.setNumberFormat(fmt);
    sh.getRange(r, 2, 1, 6).merge()
      .setFormula('=REPT("█", MIN(34, ROUND(IFERROR((' + valueExpr + ')/MAX(1,' + denomExpr + ')*34,0),0)))')
      .setFontColor(color).setFontFamily('Courier New').setFontSize(10);
    r++;
  };

  const tableHeader = (labels) => {
    sh.getRange(r, 1, 1, labels.length).setValues([labels]).setBackground(CREAM).setFontWeight('bold')
      .setFontSize(10)
      .setBorder(true, true, true, true, false, false, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
    r++;
  };
  const tableBody = (formula, rows, cols) => {
    // formula goes ONLY in the anchor cell — QUERY's array result spills
    // into the rest of this (empty) range on its own. Calling setFormula()
    // on the whole multi-cell range instead repeats the SAME formula into
    // every cell, which throws ("array result was not expanded").
    ensureGrid(sh, r + rows + 2, COLS);
    sh.getRange(r, 1).setFormula(formula);
    const range = sh.getRange(r, 1, rows, cols);
    range.setBorder(true, true, true, true, true, true, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
    try { range.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false); } catch (e) {}
    r += rows;
  };

  const started = 'COUNTA(' + SUB + '$A$2:$A)';
  const completed = 'COUNTIF(' + SUB + '$D$2:$D,"complete")';

  /* ---- KPI tiles ---- */
  section('AT A GLANCE');
  kpiRow([
    ['Sessions started', started, '0'],
    ['Completed all 9 steps', completed, '0', GREEN],
    ['Completion rate', 'IFERROR(' + completed + '/MAX(1,' + started + '),0)', '0.0%', ACCENT]
  ]);
  blank();
  kpiRow([
    ['Said "yes, I\'d love this"', 'COUNTIF(' + SUB + '$Q$2:$Q,"yes")', '0', GREEN],
    ['Avg daily spend', 'IFERROR(AVERAGEIF(' + SUB + '$N$2:$N,">0"),0)', '₹#,##0'],
    ['Avg one-way commute', 'IFERROR(AVERAGEIF(' + SUB + '$O$2:$O,">0"),0)', '0" min"']
  ]);
  blank();
  kpiRow([
    ['Colleges reached', 'COUNTUNIQUE(' + SUB + '$I$2:$I)', '0'],
    ['Metro stations reached', 'COUNTUNIQUE(' + SUB + '$L$2:$L)', '0'],
    ['Modes per commute (avg)', 'IFERROR(AVERAGEIF(' + SUB + '$AC$2:$AC,">0"),0)', '0.0', ACCENT]
  ]);
  blank();
  kpiRow([
    ['Link visits (all slugs)', 'IFERROR(SUM(Slug!$F$2:$F),0)', '0'],
    ['Multi-mode commuters', 'COUNTIF(' + SUB + '$AC$2:$AC,">1")', '0'],
    ['Single-mode commuters', 'COUNTIF(' + SUB + '$AC$2:$AC,"=1")', '0']
  ]);
  blank(16);

  /* ---- funnel: where people stop ---- */
  section('STEP FUNNEL — how far people get (share of everyone who started)');
  for (let s = 1; s <= 9; s++) {
    barRow('Step ' + s + ' · ' + STEP_LABELS[s - 1],
      'COUNTIF(' + SUB + '$S$2:$S,">=" & ' + s + ')', started,
      s === 9 ? GREEN : INK, '0');
  }
  note('The step where the bar first shrinks sharply is where the form is losing people.');
  blank(16);

  /* ---- traffic funnel from the Slug tab ---- */
  section('LINK FUNNEL — visits → starts → completions');
  const visits = 'IFERROR(SUM(Slug!$F$2:$F),0)';
  barRow('Page visits', visits, visits, INK, '0');
  barRow('Form sessions started', started, visits, ACCENT, '0');
  barRow('Forms completed', completed, visits, GREEN, '0');
  blank(16);

  /* ---- breakdowns ---- */
  section('DEVICE');
  ['ios', 'android', 'desktop'].forEach(d => {
    barRow(d, 'COUNTIF(' + SUB + '$U$2:$U,"' + d + '")', started, INK, '0');
  });
  blank(16);

  section('WHAT THEY TAKE TO COLLEGE (multi-select — picks overlap)');
  note('Counted off the TravelModes tab, one row per person per mode, so these add up to more than the number of people.');
  TRAVEL_MODES.forEach(m => {
    const labels = [m].concat(TRAVEL_MODE_ALIASES[m] || []);
    barRow(m, labels.map(l => 'COUNTIF(TravelModes!$H$2:$H,"' + l + '")').join('+'), started, INK, '0');
  });
  blank();
  section('MOST COMMON MODE COMBINATIONS');
  tableHeader(['Modes used together', 'People', 'Avg spend/day']);
  tableBody('=IFERROR(QUERY(QUERY(' + SUB + 'A2:AC,' +
    '"select M, count(A), avg(N) where M is not null and M != \'\' group by M order by count(A) desc limit 12",0),' +
    '"select * offset 1",0), "No data yet")', 12, 3);
  blank(16);

  section('HOW THE COMMUTE FEELS');
  FEELINGS.forEach(f => {
    barRow(f, 'COUNTIF(' + SUB + '$P$2:$P,"' + f + '")', started,
      (f === 'Tired out' || f === 'Draining') ? ACCENT : INK, '0');
  });
  blank(16);

  section('INTEREST IN SHARING A DAILY CAB');
  barRow('Yes, I\'d love this', 'COUNTIF(' + SUB + '$Q$2:$Q,"yes")', started, GREEN, '0');
  barRow('Maybe / not right now', 'COUNTIF(' + SUB + '$Q$2:$Q,"no")', started, ACCENT, '0');
  barRow('Never answered (dropped before step 8)',
    'MAX(0,' + started + '-COUNTIF(' + SUB + '$Q$2:$Q,"yes")-COUNTIF(' + SUB + '$Q$2:$Q,"no"))',
    started, '#7A8A88', '0');
  blank(16);

  /* ---- engagement links (CTAs). Empty until a link is configured in
     index.html — that is a real answer, not a broken tile. ---- */
  section('ENGAGEMENT LINKS — outbound taps');
  tableHeader(['Link', 'People who tapped', 'Share of completions', 'Last tap']);
  [['WhatsApp / commute group', 'X'], ['App download', 'Y'], ['Invited a friend', 'Z']].forEach(pair => {
    const col = SUB + '$' + pair[1] + '$2:$' + pair[1];
    sh.getRange(r, 1).setValue(pair[0]).setFontSize(10);
    sh.getRange(r, 2).setFormula('=COUNT(' + col + ')').setNumberFormat('0');
    sh.getRange(r, 3).setFormula('=IFERROR(COUNT(' + col + ')/MAX(1,' + completed + '),0)').setNumberFormat('0.0%');
    sh.getRange(r, 4).setFormula('=IFERROR(TEXT(MAX(' + col + '),"d mmm, HH:mm"),"—")');
    sh.getRange(r, 1, 1, 4)
      .setBorder(true, true, true, true, true, true, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
    r++;
  });
  blank(16);

  /* ---- slug links ---- */
  section('TOP CAMPAIGN / SLUG LINKS (by visits)');
  tableHeader(['Slug', 'Type', 'Destination / owner', 'Visits', 'Clicks', 'Starts', 'Completions']);
  tableBody('=IFERROR(QUERY(Slug!A2:I500,"select A, B, C, F, G, H, I where A is not null order by F desc limit 12", 0), "No data yet")', 12, 7);
  blank(16);

  /* ---- where demand is concentrated ----
     QUERY with `group by` always emits a label row ahead of its results,
     which would sit under the header drawn above. The outer
     "select * offset 1" drops it. */
  section('TOP COLLEGES');
  tableHeader(['College', 'Sessions', 'Completed all 9']);
  const collegeAnchor = r;
  tableBody('=IFERROR(QUERY(QUERY(' + SUB + 'A2:AC,' +
    '"select I, count(A) where I is not null and I != \'\' group by I order by count(A) desc limit 12",0),' +
    '"select * offset 1",0), "No data yet")', 12, 3);
  // the QUERY language used by Sheets has no conditional aggregate, so the
  // completed-count is derived off whatever college each spilled row lands on.
  for (let i = 0; i < 12; i++) {
    const rowRef = collegeAnchor + i;
    sh.getRange(rowRef, 3).setFormula('=IF($A' + rowRef + '="","",COUNTIFS(' +
      SUB + '$I$2:$I,$A' + rowRef + ',' + SUB + '$D$2:$D,"complete"))').setNumberFormat('0');
  }
  blank(16);

  section('TOP HOME METRO STATIONS');
  tableHeader(['Nearest metro station', 'Sessions', 'Avg spend/day']);
  tableBody('=IFERROR(QUERY(QUERY(' + SUB + 'A2:AC,' +
    '"select L, count(A), avg(N) where L is not null and L != \'\' group by L order by count(A) desc limit 12",0),' +
    '"select * offset 1",0), "No data yet")', 12, 3);
  blank(16);

  /* ---- people ---- */
  section('RECENT COMPLETIONS — ready to contact');
  tableHeader(['Name', 'College', 'Phone', 'From (metro)', '₹/day', 'Interested', 'Finished at']);
  tableBody('=IFERROR(QUERY(' + SUB + 'A2:AC,' +
    '"select H, I, J, L, N, Q, C where D = \'complete\' order by C desc limit 20",0), "No completions yet")',
    20, 7);
  blank(16);

  section('DROPPED OFF BUT LEFT A PHONE NUMBER — worth a follow-up');
  tableHeader(['Name', 'College', 'Phone', 'Got to step', 'Last seen', 'Entry link']);
  tableBody('=IFERROR(QUERY(' + SUB + 'A2:AC,' +
    '"select H, I, J, S, C, E where D = \'partial\' and J is not null and J != \'\' order by C desc limit 20",0), "Nobody yet")',
    20, 6);
  blank(16);

  section('BUILD STAMPS — which version of the page rows came from');
  tableHeader(['clientBuild', 'Rows']);
  tableBody('=IFERROR(QUERY(QUERY(' + SUB + 'A2:AC,' +
    '"select AA, count(A) where AA is not null group by AA order by count(A) desc limit 6",0),' +
    '"select * offset 1",0), "No data yet")', 6, 2);

  sh.setColumnWidth(1, 210);
  for (let c = 2; c <= COLS; c++) sh.setColumnWidth(c, 108);
  sh.setFrozenRows(2);
  SpreadsheetApp.flush();
}

/* ------------------------------------------------------------------ */
/* Self-test + setup + menu                                            */
/* ------------------------------------------------------------------ */

/* Distinguishes "the script is broken" from "nothing is reaching the
   script" — from the Sheet alone those two look identical. */
function runSelfTest() {
  const lines = []; const say = m => { lines.push(m); console.log(m); };
  say('code version: ' + CODE_VERSION);
  const sub = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  say('columns: ' + sub.getLastColumn() + ' (expected ' + SUBMISSION_HEADERS.length + ')');
  const before = sub.getLastRow();
  const payload = {
    action: 'submit', sessionId: 'SELFTEST', status: 'complete',
    slug: 'selftest', fullName: 'Self Test', college: 'Test College',
    phone: '9999999999', email: '', metroStation: 'Rajiv Chowk',
    travelMode: 'Walking, Metro', travelModesJSON: '["Walking","Metro"]',
    travelModeCount: 2, dailySpend: 120, oneWayMinutes: 150,
    commuteFeeling: 'Draining', sharedCabInterest: 'yes',
    currentScreen: 'step9', screensReached: 9, totalScreens: 9,
    device: 'desktop', userAgent: 'self-test', eventsJSON: '[]',
    clientBuild: 'self-test'
  };
  let reply;
  try { reply = doPost({ postData: { contents: JSON.stringify(payload) } }).getContent(); }
  catch (err) { reply = 'THREW: ' + (err && err.message ? err.message : err); }
  say('doPost said: ' + reply);
  say('rows ' + before + ' -> ' + sub.getLastRow());
  const row = findRow(sub, S_SESSION, 'SELFTEST');
  say(row > 0 ? ('SELFTEST row is at row ' + row) : 'NO ROW WAS WRITTEN — see the Errors tab.');
  const modes = rebuildTravelModes();
  say('TravelModes rebuilt: ' + modes.rows + ' rows (' + modes.legacy + ' recovered from legacy single values)');
  const errs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ERROR_SHEET);
  say(errs && errs.getLastRow() > 1
    ? ('last error: ' + errs.getRange(errs.getLastRow(), 4).getValue())
    : 'no errors recorded');
  const report = lines.join('\n');
  try { SpreadsheetApp.getUi().alert('Self test', report, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return report;
}

/* Removes the SELFTEST row so it never pollutes the real numbers. */
function deleteSelfTestRow() {
  const sh = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  const row = findRow(sh, S_SESSION, 'SELFTEST');
  if (row > 0) sh.deleteRow(row);
  const slug = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const srow = findRow(slug, L_SLUG, 'selftest');
  if (srow > 0) slug.deleteRow(srow);
  rebuildTravelModes(); // derived from Submissions, so it has to follow the delete
  SpreadsheetApp.getActiveSpreadsheet().toast(row > 0 ? 'Self-test row removed.' : 'No self-test row found.');
}

/* The on-completion refresh above is throttled and best-effort, so the
   hourly trigger is the floor that guarantees the derived tab is never
   more than an hour stale even if nobody completes the form. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'rebuildTravelModes') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rebuildTravelModes').timeBased().everyHours(1).create();
}

function setupSheets() {
  getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  getSheet(SLUG_SHEET, SLUG_HEADERS);
  getSheet(ERROR_SHEET, ERROR_HEADERS);
  getSheet(TRAVELMODES_SHEET, TRAVELMODES_HEADERS);
  applyConditionalFormatting();
  rebuildTravelModes();
  try { installTriggers(); } catch (err) { logError(err, { action: 'installTriggers' }); }
  buildDashboard();
  SpreadsheetApp.getActiveSpreadsheet().toast('Setup complete.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('PicaPool')
    .addItem('Run self test', 'runSelfTest')
    .addItem('Rebuild dashboard', 'buildDashboard')
    .addItem('Rebuild TravelModes report', 'rebuildTravelModes')
    .addItem('Backfill old rows into TravelModes', 'backfillTravelModes')
    .addItem('Delete self-test row', 'deleteSelfTestRow')
    .addItem('Run full setup', 'setupSheets')
    .addToUi();
}
