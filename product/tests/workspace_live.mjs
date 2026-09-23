#!/usr/bin/env node
/**
 * End-to-end: Service Operations Workspace list -> "Analyse in COMMAND" -> the
 * analysis in the workspace's own modal, in a real browser, as a real login.
 *
 *   node product/tests/workspace_live.mjs [--user ceo.leader] [--shots DIR] [--only s3]
 *
 * Normally run through workspace_live.py, which adds the count oracle. For every
 * scenario this drives what an agent does -- open a workspace list, optionally
 * group by a column through the column's own menu or tick rows, click the header
 * button -- then reads the payload the page embedded inside the modal's iframe
 * (same origin, so its document is readable) and prints one JSON line of facts:
 * what the list sent, what the server accepted, how many rows it analysed, how
 * many panels drew, and how long it took.
 *
 * Headless Chrome over the DevTools protocol, Node 22's built-in WebSocket, no
 * dependencies. Credentials from product/deploy/credentials.json, never printed.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const cred = JSON.parse(readFileSync(join(HERE, '..', 'deploy', 'credentials.json'), 'utf8'));
const BASE = `https://${cred.instance}`;
const USER = args.user || cred.username;
const PW = args.user ? cred.demo_password : cred.password;
const SHOTS = args.shots || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/* Each scenario is a real SOW list, by its sys_ux_list id, plus what the agent
   does on it before clicking. Chosen to cover: no filter, a plain filter, a
   column group-by, a row selection, an allowlisted javascript: filter, a dynamic
   filter, other tables (knowledge, requests, CMDB) and an empty list. */
const SCENARIOS = [
  { id: 's1', name: 'Incidents - All, whole-list overview', list: '7ae4da1ec3013010965e070e9140dd66', tile: 'Whole-list overview' },
  { id: 's2', name: 'Incidents - Open, column Priority', list: 'b16a321ac3013010965e070e9140dd3a', tile: 'Priority' },
  { id: 's3', name: 'Incidents - All, grouped by Priority from the column menu',
    list: '7ae4da1ec3013010965e070e9140dd66', group: 'Priority' },
  { id: 's4', name: 'Incidents - Open, three rows selected',
    list: 'b16a321ac3013010965e070e9140dd3a', select: 3 },
  { id: 's5', name: 'Tasks - Assigned to you (javascript:getMyAssignments())',
    list: 'cabc35660b023010bac9818393673a21' },
  { id: 's6', name: 'Knowledge - All articles', list: '12103f09533330105264ddeeff7b127e' },
  { id: 's7', name: 'Requests - Open items', list: '39c0de18c3753010965e070e9140ddd3' },
  { id: 's8', name: 'CMDB - Servers', list: 'c8725c5553b330105264ddeeff7b1212' },
  { id: 's9', name: 'Interactions - Assigned to you (dynamic, likely empty)',
    list: '1e44b5eb53313010b569ddeeff7b129f' },
  { id: 's10', name: 'Incidents - Open, one row ticked = this record in context',
    list: 'b16a321ac3013010965e070e9140dd3a', select: 1 },
  { id: 's11', name: 'Incidents - Open, "Analyse by" changed to State in the modal',
    list: 'b16a321ac3013010965e070e9140dd3a', pick: 'state' },
  { id: 's12', name: 'Reports (workspace simple list), one report ticked',
    url: '/now/sow/simplelist/sys_report', select: 1 },
];

const PORT = 9400 + Math.floor(Math.random() * 400);
const PROFILE = join(tmpdir(), 'cmd-ws-profile-' + USER);
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(args.chrome || '/usr/bin/google-chrome', ['--headless=new',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1920,1080',
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map(), listeners = [], errors = [];
function send(method, params = {}) {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}
function waitEvent(name, timeout = 60000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + name)), timeout);
    listeners.push({ name, fn: (p) => { clearTimeout(t); res(p); } });
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function navigate(url) {
  const l = waitEvent('Page.loadEventFired', 180000);
  await send('Page.navigate', { url: url.startsWith('http') ? url : BASE + url }); await l;
}
async function waitFor(expr, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(`!!(${expr})`)) return Date.now() - t0; } catch (e) { /* mid-load */ }
    await sleep(250);
  }
  return -1;
}

/* Workspace UI is web components all the way down, so every lookup walks
   shadow roots. Installed on each page load. */
const DEEP = `window.__deep = function(sel){ var out=[]; (function walk(n){ if(!n||!n.querySelectorAll) return;
  n.querySelectorAll(sel).forEach(function(e){out.push(e)});
  n.querySelectorAll('*').forEach(function(e){ if(e.shadowRoot) walk(e.shadowRoot); }); })(document); return out; };
  window.__btn = function(re){ return __deep('button').filter(function(e){ return re.test((e.getAttribute('aria-label')||'')+' '+(e.textContent||'').trim()); })[0]; };
  /* The modal holds cmd_frame, which holds the dashboard in #cmd-inner. */
  window.__cmdFrame = function(){ var o=__deep('iframe').filter(function(f){ return /cmd_frame/.test(f.src); })[0];
    if(!o||!o.contentDocument) return null; var i=o.contentDocument.getElementById('cmd-inner');
    return i && i.contentDocument && /cmd_dashboard/.test(i.contentWindow.location.href) ? i : null; };
  true`;

async function login() {
  await navigate('/login.do');
  const landed = waitEvent('Page.loadEventFired', 90000);
  await evaluate(`(function(){var u=document.getElementById('user_name'),p=document.getElementById('user_password');
    u.value=${JSON.stringify(USER)};p.value=${JSON.stringify(PW)};
    var b=document.getElementById('sysverb_login'); if(b)b.click(); else p.form.submit(); return 1;})()`);
  await landed;
  await waitFor(`document.readyState==='complete' && location.pathname.indexOf('login.do')===-1`);
  await sleep(2000);
}

async function run(sc) {
  const r = { id: sc.id, name: sc.name, user: USER };
  const t0 = Date.now();
  await navigate(sc.url || `/now/sow/list/params/list-id/${sc.list}`);
  await evaluate(DEEP);
  r.buttonMs = await waitFor(`__btn(/^(?!.*this record).*Analyse in COMMAND/)`, 60000);
  if (r.buttonMs < 0) { r.fail = 'the Analyse in COMMAND button never appeared'; return r; }
  await sleep(1500);                          // let the list's rows settle

  if (sc.group) {
    /* Exactly the agent's gesture: the column's Actions menu, then Group by. */
    const opened = await evaluate(`(function(){var b=__btn(new RegExp('^${sc.group} Actions'));
      if(!b) return false; b.click(); return true;})()`);
    await sleep(900);
    const grouped = await evaluate(`(function(){var it=__deep('[role=menuitem],[role=option],button,li,div').filter(function(e){
      return e.children.length<=2 && /^Group by ${sc.group}$/.test((e.textContent||'').trim()); })[0];
      if(!it) return false; it.click(); return true;})()`);
    r.grouped = opened && grouped;
    if (!r.grouped) { r.fail = 'could not group by ' + sc.group + ' from the column menu'; return r; }
    await sleep(3500);
    await evaluate(DEEP);
  }
  if (sc.select) {
    /* Row checkboxes, skipping the select-all in the header. */
    r.selectedInList = await evaluate(`(function(){var boxes=__deep('input[type=checkbox]').filter(function(c){
      var l=(c.getAttribute('aria-label')||'')+(c.closest&&c.closest('th')?'TH':''); return !/all|TH/i.test(l); });
      var n=0; for(var i=0;i<boxes.length&&n<${sc.select};i++){ boxes[i].click(); n++; } return n;})()`);
    await sleep(1200);
  }

  const tClick = Date.now();
  if (sc.rowMenu) {
    /* The row's own more-actions menu, then our entry in it. */
    r.rowMenu = await evaluate(`(function(){var b=__deep('button').filter(function(e){return (e.getAttribute('aria-label')||'')==='more';})[${sc.rowMenu - 1}];
      if(!b) return 'no row menu'; b.click(); return 'opened';})()`);
    await sleep(1500);
    await evaluate(DEEP);
    r.rowMenuItems = await evaluate(`__deep('[role=menuitem],[role=option]').map(function(e){return (e.textContent||'').trim();}).filter(function(t){return t&&t.length<40;})`);
    const hit = await evaluate(`(function(){var it=__deep('[role=menuitem],[role=option]').filter(function(e){return /^Analyse this record in COMMAND$/.test((e.textContent||'').trim());})[0];
      if(!it) return false; it.click(); return true;})()`);
    if (!hit) { r.fail = 'Analyse this record in COMMAND is not in the row menu: ' + JSON.stringify(r.rowMenuItems); return r; }
  } else {
    await evaluate(`(function(){__btn(/^(?!.*this record).*Analyse in COMMAND/).click(); return 1;})()`);
  }
  r.modalMs = await waitFor(`__cmdFrame()`, 30000);
  if (r.modalMs < 0) { r.fail = 'no modal iframe after the click'; return r; }
  r.src = await evaluate(`__cmdFrame().src`);
  r.renderMs = await waitFor(`(function(){var d=__cmdFrame().contentDocument; var root=d&&d.getElementById('cmd-root');
    return root && root.children.length>1;})()`, 120000);
  r.clickToRenderMs = Date.now() - tClick;
  if (r.renderMs < 0) { r.fail = 'the analysis never rendered inside the modal'; return r; }

  Object.assign(r, await evaluate(`(function(){var d=__cmdFrame().contentDocument;
    var b64=d.getElementById('cmd-data').getAttribute('data-b64');
    var p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64),function(c){return c.charCodeAt(0);})));
    return { table: p.subject && p.subject.table, rows: p.subject && p.subject.rows,
             query: p.subject && p.subject.query, error: p.error || '',
             acl: p.acl || null, workspace: p.workspace || null, embed: !!p.embed,
             report: p.report || null, parity: p.parity || null,
             panelFields: (p.panels||[]).map(function(x){return x.field||x.kind;}),
             kpis: (p.kpis||[]).length, notes: p.notes||[],
             drawnPanels: d.querySelectorAll('.panel').length,
             stripText: (d.querySelector('.ws-strip')||{}).textContent||'',
             title: (d.querySelector('h1')||{}).textContent||'',
             fullScreen: !!Array.prototype.filter.call(d.querySelectorAll('a'),function(a){return /Open full screen/.test(a.textContent);}).length,
             renderErrors: Array.prototype.map.call(d.querySelectorAll('.panel .h3'),function(h){return h.textContent;}).filter(function(t){return /failed/i.test(t);}) };})()`));
  /* The first screen from a list is the column picker. Pick a column the way an
     agent does -- sc.tile, or the list's first column -- and analyse that. */
  r.emptyList = await evaluate(`/no rows you can see/.test((__cmdFrame().contentDocument.querySelector('.sub')||{}).textContent||'')`);
  r.pickerShown = await evaluate(`!!__cmdFrame().contentDocument.querySelector('.col-tile')`);
  if (r.pickerShown) {
    r.tiles = await evaluate(`Array.prototype.map.call(__cmdFrame().contentDocument.querySelectorAll('.col-tile .col-t'),function(t){return t.textContent;})`);
    r.tileClicked = await evaluate(`(function(){var d=__cmdFrame().contentDocument; var ts=d.querySelectorAll('.col-tile');
      var want=${JSON.stringify(sc.tile || '')}; var t=null;
      for(var i=0;i<ts.length;i++){ if(want && ts[i].querySelector('.col-t').textContent===want) t=ts[i]; }
      if(!t) t=ts[0]; t.click(); return t.querySelector('.col-t').textContent;})()`);
    await sleep(1500);
    r.tileRenderMs = await waitFor(`(function(){var f=__cmdFrame(); var d=f&&f.contentDocument;
      return d && /wgroup=|wall=1/.test(f.contentWindow.location.href) && d.getElementById('cmd-data') && d.getElementById('cmd-root').children.length>1;})()`, 120000);
    if (r.tileRenderMs < 0) { r.fail = 'choosing a column did not open its analysis'; return r; }
    Object.assign(r, await evaluate(`(function(){var d=__cmdFrame().contentDocument;
      var p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(d.getElementById('cmd-data').getAttribute('data-b64')),function(c){return c.charCodeAt(0);})));
      return { table: p.subject.table, rows: p.subject.rows, query: p.subject.query, error: p.error||'', workspace: p.workspace, acl: p.acl,
               fieldMode: p.fieldMode||null, panelFields: (p.panels||[]).map(function(x){return x.field||x.kind;}),
               panelTitles: (p.panels||[]).map(function(x){return x.title||'';}), focusField: p.focusField, notes: p.notes||[],
               title: (d.querySelector('h1')||{}).textContent||'', stripText: (d.querySelector('.ws-strip')||{}).textContent||'' };})()`));
  }
  if (sc.pick) {
    /* The "Analyse by" picker inside the modal, changed the way a person does. */
    r.picked = await evaluate(`(function(){var d=__cmdFrame().contentDocument; var s=d.querySelector('.ws-by-s');
      if(!s) return 'no picker'; var names=Array.prototype.map.call(s.options,function(o){return o.value;});
      if(names.indexOf(${JSON.stringify(sc.pick)})<0) return 'not offered: '+names.join(',');
      s.value=${JSON.stringify(sc.pick)}; s.dispatchEvent(new Event('change',{bubbles:true})); return 'changed';})()`);
    if (r.picked !== 'changed') { r.fail = 'picker: ' + r.picked; return r; }
    await sleep(1500);
    r.pickRenderMs = await waitFor(`(function(){var f=__cmdFrame(); var d=f&&f.contentDocument; var h=d&&d.getElementById('cmd-data');
      return h && /wgroup=${sc.pick}/.test(f.contentWindow.location.href) && d.getElementById('cmd-root').children.length>1;})()`, 120000);
    if (r.pickRenderMs < 0) {
      r.topUrl = await evaluate('location.href'); await evaluate(DEEP);
      r.fail = 'the picker did not reload the analysis: ' + await evaluate(`(function(){var f=__cmdFrame(); if(!f) return 'no frame';
        var o={src:f.src.slice(-80), sandbox:f.getAttribute('sandbox')}; try{o.loc=f.contentWindow.location.href.slice(-120); o.root=f.contentDocument.getElementById('cmd-root').children.length;}catch(e){o.err=String(e);} return JSON.stringify(o);})()`);
      return r;
    }
    Object.assign(r, await evaluate(`(function(){var d=__cmdFrame().contentDocument;
      var p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(d.getElementById('cmd-data').getAttribute('data-b64')),function(c){return c.charCodeAt(0);})));
      return { rows: p.subject.rows, query: p.subject.query, workspace: p.workspace, acl: p.acl,
               panelFields: (p.panels||[]).map(function(x){return x.field||x.kind;}), focusField: p.focusField,
               notes: p.notes||[], stripText: (d.querySelector('.ws-strip')||{}).textContent||'' };})()`));
  }
  r.recordStrip = await evaluate(`(function(){var d=__cmdFrame().contentDocument; var e=d.querySelector('.ws-rec'); return e?e.textContent:'';})()`);
  r.totalMs = Date.now() - t0;
  if (SHOTS) {
    await sleep(1500);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, `${sc.id}-${USER}.png`), Buffer.from(s.data, 'base64'));
  }
  return r;
}

(async () => {
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const p = l.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
      } catch (e) { /* not up */ }
      await sleep(250);
    }
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || '').slice(0, 200));
      for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].name === m.method) listeners.splice(i, 1)[0].fn(m.params);
    });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await navigate('/stats.do');
    if (await evaluate(`location.pathname.indexOf('login')!==-1||!!document.getElementById('user_password')`) || args.relogin) await login();

    for (const sc of SCENARIOS) {
      if (args.only && !String(args.only).split(',').includes(sc.id)) continue;
      let r;
      try { r = await run(sc); } catch (e) { r = { id: sc.id, name: sc.name, fail: String(e.message || e) }; }
      console.log(JSON.stringify(r));
    }
  } finally {
    const cmdErrors = errors.filter((e) => /cmd_|COMMAND|x_2185255/.test(e));
    console.log(JSON.stringify({ summary: true, pageExceptionsFromCommand: cmdErrors }));
    try { ws.close(); } catch (e) { /* ignore */ }
    chrome.kill('SIGTERM');
    setTimeout(() => process.exit(0), 300);
  }
})();
