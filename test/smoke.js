const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

/* Headless run of index.html: renders the form, walks all 9 steps, and
   asserts what every beacon carries. Needs jsdom:
     npm i --no-save jsdom && node test/smoke.js                         */
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const BUILD = /var BUILD = '([^']+)'/.exec(HTML)[1];
let fail = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

function boot(url, storage) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(String(e.message)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(HTML, { url, runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
  const w = dom.window;
  const beacons = [];
  w.navigator.sendBeacon = function (u, blob) { beacons.push({ url: u, body: blob && blob._buffer ? blob._buffer.toString() : null }); return true; };
  // jsdom Blob has no sync read; capture the JSON before it is wrapped instead
  w.Blob = function (parts) { this.text = parts.join(''); };
  w.navigator.sendBeacon = function (u, blob) { beacons.push(JSON.parse(blob.text)); return true; };
  if (storage) for (const k in storage) w.localStorage.setItem(k, storage[k]);
  const script = HTML.slice(HTML.indexOf('<script>') + 8, HTML.indexOf('</script>'));
  w.eval(script);
  return { w, d: w.document, beacons, errors, dom };
}

async function main(){
/* ---------- 1. cold load ---------- */
console.log('\n1. cold load on /srcc?ref=XY7ZQ2');
let { w, d, beacons, errors } = boot('https://picapool.test/srcc?ref=XY7ZQ2');
await wait(900); // the partial sync is debounced 700ms by design
ok(errors.length === 0, 'no uncaught errors' + (errors.length ? ' — ' + errors[0] : ''));
ok(d.querySelector('#screen').innerHTML.indexOf('Imagine getting') > -1, 'screen 1 rendered');
ok(!!d.querySelector('.brandmark img.brand-logo'), 'logo injected inside .word');
ok(d.querySelector('.brandmark').children.length === 2, '.brandmark still has 2 flex children (layout intact)');
ok(d.querySelectorAll('.progress-wrap .seg').length === 9, '9 progress segments');

const visit = beacons.find(b => b.action === 'track' && b.kind === 'visit');
ok(!!visit, 'visit beacon fired');
ok(visit && visit.slug === 'srcc', 'entry slug from path = srcc, got ' + (visit && visit.slug));
ok(visit && visit.ref === 'XY7ZQ2', '?ref captured');
const first = beacons.find(b => b.action === 'submit');
ok(!!first, 'submit beacon fired on first paint');
ok(first && first.status === 'partial' && first.currentScreen === 'step1', 'first submit = partial/step1');
ok(first && first.referredBy === 'XY7ZQ2', 'referredBy on the submission row');
ok(first && first.clientBuild === BUILD, 'clientBuild stamped: ' + (first && first.clientBuild));
ok(first && first.totalScreens === 9, 'totalScreens = 9');

/* ---------- 2. walk all 9 steps ---------- */
console.log('\n2. walk the form to completion');
const click = id => { const e = d.getElementById(id); if (!e) throw new Error('missing #' + id); e.click(); };
const type = (id, v) => {
  const e = d.getElementById(id); e.value = v;
  e.dispatchEvent(new w.Event('input', { bubbles: true }));
};
click('p1cta');
type('in_name', 'Ananya Sharma'); type('in_college', 'SRCC'); type('in_phone', '9876543210');
type('in_email', 'ananya@example.com');
click('p2next');
ok(!!d.getElementById('in_metro'), 'reached step 3');
type('in_metro', 'Rajiv Chowk'); click('p3next');
d.querySelector('#modeOptions .option[data-mode="Walking"]').click();
d.querySelector('#modeOptions .option[data-mode="Metro"]').click();
click('p4next');
type('in_spend', '120'); click('p5next');
type('in_time', '150'); click('p6next');
d.querySelector('#feelOptions .option[data-feel="Draining"]').click(); click('p7next');
d.querySelector('#interestOptions .option[data-interest="yes"]').click(); click('p8next');

ok(d.querySelector('#screen').innerHTML.indexOf("You&rsquo;re in!") > -1 ||
   d.querySelector('.confirm-title') !== null, 'reached the confirmation screen');
ok(errors.length === 0, 'still no uncaught errors' + (errors.length ? ' — ' + errors[0] : ''));

const done = beacons.filter(b => b.action === 'submit' && b.status === 'complete').pop();
ok(!!done, 'complete submission fired');
ok(done && done.currentScreen === 'step9' && done.screensReached === 9, 'step9 / screensReached 9');
ok(done && done.fullName === 'Ananya Sharma' && done.phone === '9876543210', 'identity fields mapped');
ok(done && done.college === 'SRCC' && done.email === 'ananya@example.com', 'college + email mapped');
ok(done && done.metroStation === 'Rajiv Chowk', 'metroStation mapped');
ok(done && done.travelMode === 'Walking, Metro', 'travelMode summary cell: ' + (done && done.travelMode));
ok(done && done.travelModesJSON === '["Walking","Metro"]', 'lossless blob for the detail tab: ' + (done && done.travelModesJSON));
ok(done && done.travelModeCount === 2, 'travelModeCount = 2');
ok(done && done.dailySpend === 120 && done.oneWayMinutes === 150, 'spend/time mapped as numbers');
ok(done && done.commuteFeeling === 'Draining' && done.sharedCabInterest === 'yes', 'feeling + interest mapped');
ok(done && /^[A-Z2-9]{6}$/.test(done.myRefCode), 'referral code generated: ' + (done && done.myRefCode));
ok(beacons.some(b => b.action === 'createLink' && b.type === 'referral'), 'createLink logged for the referral code');
ok(done && JSON.parse(done.eventsJSON).length > 8, 'event trail captured (' + (done ? JSON.parse(done.eventsJSON).length : 0) + ' events)');
ok(!d.getElementById('ppCtaRow'), 'no CTA row injected while the link constants are empty');
const sessionIds = new Set(beacons.filter(b => b.sessionId).map(b => b.sessionId));
ok(sessionIds.size === 1, 'one stable sessionId across every beacon (' + sessionIds.size + ')');

/* ---------- 3. resume ---------- */
console.log('\n3. resume in a new page load, same storage');
const saved = {};
for (let i = 0; i < w.localStorage.length; i++) {
  const k = w.localStorage.key(i); saved[k] = w.localStorage.getItem(k);
}
const r2 = boot('https://picapool.test/srcc', saved);
await wait(900);
ok(r2.errors.length === 0, 'no uncaught errors on resume');
ok(r2.d.querySelector('.confirm-title') !== null, 'landed back on step 9, not step 1');
const rv = r2.beacons.find(b => b.action === 'track' && b.kind === 'visit');
ok(rv && rv.resumed === true, 'visit beacon reports resumed:true');
ok(rv && rv.entryStep === 9, 'resumed at step 9');
const rs = r2.beacons.find(b => b.action === 'submit');
ok(rs && rs.sessionId === done.sessionId, 'same sessionId reused, so the backend upserts');
ok(rs && rs.status === 'complete', 'resumed row stays complete');
ok(rs && rs.fullName === 'Ananya Sharma', 'answers restored from localStorage');
ok(rs && rs.travelModesJSON === '["Walking","Metro"]', 'the multi-select array survives a reload');

/* ---------- 4. ?new=1 wipes ---------- */
console.log('\n4. ?new=1 starts a genuinely fresh session');
const r3 = boot('https://picapool.test/srcc?new=1', saved);
await wait(900);
ok(r3.errors.length === 0, 'no uncaught errors');
ok(r3.d.querySelector('#screen').innerHTML.indexOf('Imagine getting') > -1, 'back on step 1');
const n3 = r3.beacons.find(b => b.action === 'submit');
ok(n3 && n3.sessionId !== done.sessionId, 'new sessionId issued');
ok(n3 && !n3.fullName, 'no leftover answers');

/* ---------- 5. redirect shortlink is off until configured ---------- */
console.log('\n5. /wa with no group link configured');
const r4 = boot('https://picapool.test/wa');
await wait(900);
ok(r4.errors.length === 0, 'no uncaught errors');
ok(r4.d.querySelector('#screen').innerHTML.indexOf('Imagine getting') > -1,
   'renders the form (no redirect configured) instead of dying');
const v4 = r4.beacons.find(b => b.action === 'track' && b.kind === 'visit');
ok(v4 && v4.slug === 'wa', 'still tracked as slug "wa"');

/* ---------- 6. CTA + redirect once a link IS configured ---------- */
console.log('\n6. same page with PRIMARY_GROUP_LINK filled in');
const patched = HTML.replace(
  "var PRIMARY_GROUP_LINK = '';",
  "var PRIMARY_GROUP_LINK = 'https://chat.whatsapp.com/TESTGROUP';");
ok(patched !== HTML, 'config constant is patchable');
{
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', e => errs.push(String(e.message)));
  const dom = new JSDOM(patched, { url: 'https://picapool.test/?new=1', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
  const ww = dom.window; const bs = [];
  ww.Blob = function (parts) { this.text = parts.join(''); };
  ww.navigator.sendBeacon = function (u, b) { bs.push(JSON.parse(b.text)); return true; };
  ww.eval(patched.slice(patched.indexOf('<script>') + 8, patched.indexOf('</script>')));
  const dd = ww.document;
  dd.getElementById('p1cta').click();
  const t2 = (id, v) => { const e = dd.getElementById(id); e.value = v; e.dispatchEvent(new ww.Event('input', { bubbles: true })); };
  t2('in_name', 'B'); t2('in_college', 'C'); t2('in_phone', '9876543210'); dd.getElementById('p2next').click();
  t2('in_metro', 'AIIMS'); dd.getElementById('p3next').click();
  dd.querySelector('#modeOptions .option[data-mode="Auto/Cab"]').click(); dd.getElementById('p4next').click();
  t2('in_spend', '60'); dd.getElementById('p5next').click();
  t2('in_time', '30'); dd.getElementById('p6next').click();
  dd.querySelector('#feelOptions .option[data-feel="Relaxed"]').click(); dd.getElementById('p7next').click();
  dd.querySelector('#interestOptions .option[data-interest="yes"]').click(); dd.getElementById('p8next').click();
  const row = dd.getElementById('ppCtaRow');
  ok(!!row, 'CTA row injected on step 9');
  const a = row && row.querySelector('[data-track-cta="group"]');
  ok(!!a && a.getAttribute('href') === 'https://chat.whatsapp.com/TESTGROUP', 'group button points at the link');
  ok(!!row && !row.querySelector('[data-track-cta="app_download"]'), 'no app button (that link is still empty)');
  ok(!!row && !row.querySelector('[data-track-cta="referral_share"]'), 'no invite button (ENABLE_INVITE_CTA false)');
  ok(!!dd.querySelector('#screen .safe-bottom') && row.nextElementSibling === dd.querySelector('#screen .safe-bottom'),
     'injected above .safe-bottom, existing markup untouched');
  if (a) a.click();
  const clickTrack = bs.filter(b => b.action === 'track' && b.kind === 'click' && b.slug === 'group').pop();
  ok(!!clickTrack, 'tap on the group button fires a click beacon');
  const afterClick = bs.filter(b => b.action === 'submit').pop();
  ok(afterClick && typeof afterClick.groupClickedAt === 'number', 'groupClickedAt stamped on that person\'s own row');
  ok(errs.length === 0, 'no uncaught errors' + (errs.length ? ' — ' + errs[0] : ''));
}

/* ---------- 7. flush on tab hide ---------- */
console.log('\n7. flush when the tab goes away');
{
  const r = boot('https://picapool.test/?new=1');
  const before = r.beacons.length;
  r.w.dispatchEvent(new r.w.Event('pagehide'));
  ok(r.beacons.length > before, 'pagehide forces an immediate flush');
}

/* ---------- 8. survives a hostile webview ---------- */
console.log('\n8. locked-down webview: no sendBeacon, no fetch, no localStorage');
{
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', e => errs.push(String(e.message)));
  const dom = new JSDOM(HTML, { url: 'https://picapool.test/', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
  const ww = dom.window;
  delete ww.navigator.sendBeacon;
  ww.fetch = undefined;
  Object.defineProperty(ww, 'localStorage', { get() { throw new Error('blocked'); } });
  ww.eval(HTML.slice(HTML.indexOf('<script>') + 8, HTML.indexOf('</script>')));
  ok(errs.length === 0, 'no uncaught errors' + (errs.length ? ' — ' + errs[0] : ''));
  const dd = ww.document;
  ok(dd.querySelector('#screen').innerHTML.indexOf('Imagine getting') > -1, 'form still renders');
  dd.getElementById('p1cta').click();
  ok(!!dd.getElementById('in_name'), 'form still navigates');
}


/* ---------- 9. tap feedback + auto-advance ---------- */
console.log('\n9. sound, vibration, and auto-advance');
{
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', e => errs.push(String(e.message)));
  const dom = new JSDOM(HTML, { url: 'https://picapool.test/?new=1', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
  const ww = dom.window;
  ww.Blob = function (parts) { this.text = parts.join(''); };
  const bs = [];
  ww.navigator.sendBeacon = function (u, b) { bs.push(JSON.parse(b.text)); return true; };

  /* record what the page asks the audio + vibration APIs to do */
  const notes = [];
  const vibes = [];
  ww.navigator.vibrate = p => { vibes.push(p); return true; };
  let resumed = 0;
  ww.AudioContext = function () {
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = {};
    this.resume = () => { resumed++; this.state = 'running'; return Promise.resolve(); };
    this.createOscillator = () => ({
      type: '', frequency: { setValueAtTime: (f) => notes.push(f) },
      connect() {}, start() {}, stop() {}
    });
    this.createGain = () => ({
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}
    });
  };
  ww.eval(HTML.slice(HTML.indexOf('<script>') + 8, HTML.indexOf('</script>')));
  const dd = ww.document;
  const t = (id, v) => { const e = dd.getElementById(id); e.value = v; e.dispatchEvent(new ww.Event('input', { bubbles: true })); };

  // walk to the first auto-advance screen the ordinary way
  dd.getElementById('p1cta').click();
  ok(notes.length > 0, 'first tap constructs the AudioContext and plays a note');
  ok(resumed > 0, 'suspended context is resumed inside the gesture (iOS needs this)');
  ok(vibes.length > 0, 'first tap vibrates');
  t('in_name', 'A'); t('in_college', 'B'); t('in_phone', '9876543210');
  dd.getElementById('p2next').click();
  t('in_metro', 'AIIMS'); dd.getElementById('p3next').click();
  ok(!!dd.getElementById('modeOptions'), 'on step 4 (travel modes, multi-select)');

  /* page 4 is the one screen that must NOT auto-advance: advancing on the
     first tap would make a second mode impossible to pick. */
  dd.querySelector('#modeOptions .option[data-mode="Walking"]').click();
  await wait(700);
  ok(!!dd.getElementById('modeOptions'), 'multi-select does NOT auto-advance');
  dd.querySelector('#modeOptions .option[data-mode="Metro"]').click();
  ok(dd.querySelectorAll('#modeOptions .option.sel').length === 2, 'both taps stay selected');
  dd.getElementById('p4next').click();
  ok(!!dd.getElementById('in_spend'), 'Next moves on once modes are picked');

  // ---- from here on, NOTHING presses Next ----

  const beforeChip = notes.length;
  dd.querySelector('#spendChips .chip[data-v="120"]').click();
  ok(notes.length > beforeChip, 'chip tap makes a sound');
  ok(dd.getElementById('spendInsight').textContent.indexOf('3,120') > -1,
     'the monthly-spend insight is on screen while we wait');
  await wait(400);
  ok(!!dd.getElementById('in_spend'), 'chips wait ~900ms so that insight actually lands');
  await wait(800);
  ok(!!dd.getElementById('in_time'), 'auto-advanced to step 6');

  dd.querySelector('#timeChips .chip[data-v="30"]').click();
  await wait(1200);
  ok(!!dd.getElementById('feelOptions'), 'auto-advanced to step 7');

  dd.querySelector('#feelOptions .option[data-feel="Relaxed"]').click();
  await wait(600);
  ok(!!dd.getElementById('interestOptions'), 'auto-advanced to step 8');

  const beforeFinish = notes.length;
  dd.querySelector('#interestOptions .option[data-interest="yes"]').click();
  await wait(700);
  ok(dd.querySelector('.confirm-title') !== null, 'auto-advanced to step 9 and submitted');
  ok(notes.length - beforeFinish >= 3, 'arrival plays a 3-note flourish (' + (notes.length - beforeFinish) + ' notes)');
  ok(Array.isArray(vibes[vibes.length - 1]), 'finish uses a vibration pattern, not a single buzz');

  const done = bs.filter(b => b.action === 'submit' && b.status === 'complete').pop();
  ok(!!done, 'the completed row still went out');
  ok(done && done.travelMode === 'Walking, Metro' && done.dailySpend === 120 && done.oneWayMinutes === 30,
     'every auto-advanced answer was captured');
  ok(done && done.commuteFeeling === 'Relaxed' && done.sharedCabInterest === 'yes',
     'feeling + interest captured');

  ok(errs.length === 0, 'no uncaught errors' + (errs.length ? ' — ' + errs[0] : ''));

  /* a returning visitor resuming straight onto step 9 must NOT get the
     flourish: there is no user gesture there, so the browser would block
     the audio anyway and the haptic would fire out of nowhere. */
  const saved9 = {};
  for (let i = 0; i < ww.localStorage.length; i++) {
    const k = ww.localStorage.key(i); saved9[k] = ww.localStorage.getItem(k);
  }
  const vc2 = new VirtualConsole(); const errs2 = [];
  vc2.on('jsdomError', e => errs2.push(String(e.message)));
  const dom2 = new JSDOM(HTML, { url: 'https://picapool.test/', runScripts: 'outside-only', virtualConsole: vc2, pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.Blob = function (parts) { this.text = parts.join(''); };
  w2.navigator.sendBeacon = function () { return true; };
  const notes2 = [], vibes2 = [];
  w2.navigator.vibrate = p => { vibes2.push(p); return true; };
  w2.AudioContext = function () {
    this.currentTime = 0; this.state = 'running'; this.destination = {};
    this.resume = () => Promise.resolve();
    this.createOscillator = () => ({ type: '', frequency: { setValueAtTime: f => notes2.push(f) }, connect() {}, start() {}, stop() {} });
    this.createGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
  };
  for (const k in saved9) w2.localStorage.setItem(k, saved9[k]);
  w2.eval(HTML.slice(HTML.indexOf('<script>') + 8, HTML.indexOf('</script>')));
  ok(w2.document.querySelector('.confirm-title') !== null, 'resumed onto step 9');
  ok(notes2.length === 0, 'no flourish on resume (' + notes2.length + ' notes played)');
  ok(vibes2.length === 0, 'no haptic on resume');
  ok(errs2.length === 0, 'no uncaught errors on resume');
}

/* ---------- 10. feedback never breaks a hostile webview ---------- */
console.log('\n10. webview that refuses AudioContext and has no vibrate');
{
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', e => errs.push(String(e.message)));
  const dom = new JSDOM(HTML, { url: 'https://picapool.test/?new=1', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
  const ww = dom.window;
  ww.Blob = function (parts) { this.text = parts.join(''); };
  ww.navigator.sendBeacon = function () { return true; };
  ww.AudioContext = function () { throw new Error('not allowed in this webview'); };
  ww.webkitAudioContext = undefined;
  delete ww.navigator.vibrate;
  ww.eval(HTML.slice(HTML.indexOf('<script>') + 8, HTML.indexOf('</script>')));
  const dd = ww.document;
  dd.getElementById('p1cta').click();
  ok(errs.length === 0, 'a refused AudioContext does not throw' + (errs.length ? ' — ' + errs[0] : ''));
  ok(!!dd.getElementById('in_name'), 'form still navigates');
  const t = (id, v) => { const e = dd.getElementById(id); e.value = v; e.dispatchEvent(new ww.Event('input', { bubbles: true })); };
  t('in_name', 'A'); t('in_college', 'B'); t('in_phone', '9876543210');
  dd.getElementById('p2next').click();
  t('in_metro', 'AIIMS'); dd.getElementById('p3next').click();
  dd.querySelector('#modeOptions .option[data-mode="Walking"]').click();
  dd.getElementById('p4next').click();
  dd.querySelector('#spendChips .chip[data-v="60"]').click();
  await wait(1100);
  ok(!!dd.getElementById('in_time'), 'auto-advance still works with no audio at all');
  ok(errs.length === 0, 'still no uncaught errors');
}


/* ---------- 11. the MSDF-HRC-024 refinement spec, item by item ---------- */
console.log('\n11. refinement spec compliance (MSDF-HRC-024, pages 1-5)');
{
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', e => errs.push(String(e.message)));
  const dom = new JSDOM(HTML, { url: 'https://picapool.test/?new=1', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
  const ww = dom.window;
  ww.Blob = function (parts) { this.text = parts.join(''); };
  const bs = [];
  ww.navigator.sendBeacon = function (u, b) { bs.push(JSON.parse(b.text)); return true; };
  ww.eval(HTML.slice(HTML.indexOf('<script>') + 8, HTML.indexOf('</script>')));
  const dd = ww.document;
  const t = (id, v) => { const e = dd.getElementById(id); e.value = v; e.dispatchEvent(new ww.Event('input', { bubbles: true })); };

  dd.getElementById('p1cta').click();
  t('in_name', 'Spec Check'); t('in_college', 'SRCC'); t('in_phone', '9876543210');
  dd.getElementById('p2next').click();

  // --- Page 3: remove GTB Nagar and Vishwavidyalaya, keep the rest
  const stations = [...dd.querySelectorAll('#metroList option')].map(o => o.value);
  ok(stations.indexOf('GTB Nagar') === -1, 'page 3: GTB Nagar removed');
  ok(stations.indexOf('Vishwavidyalaya') === -1, 'page 3: Vishwavidyalaya removed');
  ok(stations.indexOf('Rajiv Chowk') > -1 && stations.indexOf('Azadpur') > -1,
     'page 3: other stations kept (' + stations.length + ' left)');

  t('in_metro', 'Azadpur'); dd.getElementById('p3next').click();

  // --- Page 4: copy, multi-select, order, checkbox on the left
  ok(dd.querySelector('.question').textContent === 'What all do you take to get to college?',
     'page 4: question copy — "' + dd.querySelector('.question').textContent + '"');
  ok((dd.querySelector('.helper') || {}).textContent === 'Select all modes you use in your commute journey.',
     'page 4: instructional subheading added');
  const opts = [...dd.querySelectorAll('#modeOptions .option')];
  ok(opts.map(o => o.getAttribute('data-mode')).join('|') ===
     'Walking|Metro|Rapid (Rapido)|Personal vehicle|Auto/Cab|Other',
     'page 4: options in spec order — ' + opts.map(o => o.getAttribute('data-mode')).join(', '));
  ok(opts.every(o => o.getAttribute('role') === 'checkbox'),
     'page 4: role=checkbox, not radio');
  ok(opts.every(o => o.firstElementChild && o.firstElementChild.classList.contains('box')),
     'page 4: the check box is the FIRST child, so it renders on the left');
  ok(opts.every(o => !o.querySelector('.dot')),
     'page 4: no round radio dot left behind');
  ok(dd.getElementById('modeOptions').getAttribute('role') === 'group',
     'page 4: container is a group, not a radiogroup');

  // multi-select really is multi
  opts[0].click(); opts[1].click(); opts[4].click();
  ok(dd.querySelectorAll('#modeOptions .option.sel').length === 3, 'page 4: three modes selected at once');
  opts[1].click();
  ok(dd.querySelectorAll('#modeOptions .option.sel').length === 2, 'page 4: tapping again deselects');
  ok(opts[0].getAttribute('aria-checked') === 'true' && opts[1].getAttribute('aria-checked') === 'false',
     'page 4: aria-checked tracks each box independently');

  // validation: an empty selection must not advance
  opts[0].click(); opts[4].click();
  ok(dd.querySelectorAll('#modeOptions .option.sel').length === 0, 'page 4: cleared the selection');
  dd.getElementById('p4next').click();
  ok(!!dd.getElementById('modeOptions'), 'page 4: Next is blocked while nothing is selected');
  ok(!!dd.querySelector('.inline-alert'), 'page 4: inline "select at least one" alert shown');

  opts[4].click(); opts[0].click(); // Auto/Cab then Walking — deliberately out of order
  dd.getElementById('p4next').click();
  ok(!!dd.getElementById('in_spend'), 'page 4: advances once something is picked');

  t('in_spend', '150'); dd.getElementById('p5next').click();

  // --- Page 5/6: time chips now run 30 to 180 in 30-minute steps
  const chips = [...dd.querySelectorAll('#timeChips .chip')].map(c => Number(c.getAttribute('data-v')));
  ok(chips.join(',') === '30,60,90,120,150,180', 'time chips are 30-180 in 30s — ' + chips.join(', '));
  ok(Math.max(...chips) === 180, 'max option is 3 hours (180 minutes)');

  t('in_time', '180'); dd.getElementById('p6next').click();
  dd.querySelector('#feelOptions .option[data-feel="Draining"]').click();
  dd.getElementById('p7next').click();
  dd.querySelector('#interestOptions .option[data-interest="yes"]').click();
  dd.getElementById('p8next').click();

  // --- Page 9 has to survive several modes
  ok(dd.querySelector('.confirm-title') !== null, 'reached the confirmation screen');
  const tags = [...dd.querySelectorAll('.commute-tag')].map(x => x.textContent);
  ok(tags.indexOf('Walking') > -1 && tags.indexOf('Auto/Cab') > -1,
     'page 9: one tag per selected mode — ' + tags.join(' / '));
  ok(tags.indexOf('undefined') === -1, 'page 9: no "undefined" tag from the old single-value field');

  const done = bs.filter(b => b.action === 'submit' && b.status === 'complete').pop();
  ok(done && done.travelMode === 'Walking, Auto/Cab',
     'summary cell is in canonical option order, not tap order — "' + (done && done.travelMode) + '"');
  ok(done && done.travelModesJSON === '["Walking","Auto/Cab"]', 'blob matches');
  ok(done && done.travelModeCount === 2, 'count matches');
  ok(done && done.oneWayMinutes === 180, '180-minute answer accepted');
  ok(errs.length === 0, 'no uncaught errors' + (errs.length ? ' — ' + errs[0] : ''));
}

}
main().then(() => {
  console.log(fail === 0 ? '\nALL CHECKS PASSED\n' : '\n' + fail + ' CHECK(S) FAILED\n');
  process.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('THREW: ' + e.stack); process.exit(1); });
