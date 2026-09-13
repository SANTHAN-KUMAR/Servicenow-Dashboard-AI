#!/usr/bin/env node
/**
 * A real browser against the instance, for the things only a browser can answer.
 *
 *   node product/tests/browse.mjs --url /x_2185255_command_cmd_ceo.do \
 *        --wait "window.__cmdCeoReady===true" --shot out.png --width 1920
 *
 * Payload assertions have passed while the screen was wrong more than once on this
 * engagement, and two questions cannot be asked of a payload at all: does a
 * GlideAjax call from a UI Page actually return here (an XHR to Scripted REST
 * measurably never did on eypocinst), and how long does the page take to become
 * something a person can use. So this drives headless Chrome over the DevTools
 * protocol -- Node 22's built-in WebSocket, no dependencies -- logs in through the
 * real login form, loads the page, waits for a condition, and reports timings,
 * console errors and an optional screenshot.
 *
 * Credentials are read from product/deploy/credentials.json and never printed.
 * One profile directory is reused so the session survives between runs.
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

const cred = JSON.parse(readFileSync(join(HERE, '..', 'deploy', args.credentials || 'credentials.json'), 'utf8'));
const BASE = `https://${cred.instance}`;
const W = parseInt(args.width || '1600', 10), H = parseInt(args.height || '1000', 10);
const PORT = 9300 + Math.floor(Math.random() * 500);
const PROFILE = args.profile || join(tmpdir(), 'cmd-browse-profile-' + (args.user || 'admin'));
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(args.chrome || '/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=' + (args.scale || '1'),
  'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const listeners = [];
const consoleLines = [];

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome did not start');
}

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

function waitEvent(name, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + name)), timeout);
    listeners.push({ name, fn: (p) => { clearTimeout(t); resolve(p); } });
  });
}

async function evaluate(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

async function navigate(url) {
  const load = waitEvent('Page.loadEventFired', 180000);
  await send('Page.navigate', { url });
  await load;
}

async function waitFor(expr, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(`!!(${expr})`)) return Date.now() - t0; } catch (e) { /* page mid-load */ }
    await sleep(100);
  }
  return -1;
}

async function login(user, pw) {
  await navigate(`${BASE}/login.do`);
  await evaluate(`(function(){var u=document.getElementById('user_name'),p=document.getElementById('user_password');
    u.value=${JSON.stringify(user)};p.value=${JSON.stringify(pw)};
    var b=document.getElementById('sysverb_login'); if(b){b.click();}else{p.form.submit();} return true;})()`, false);
  await sleep(1500);
  await waitFor(`document.readyState==='complete' && location.pathname.indexOf('login.do')===-1`, 60000);
}

(async () => {
  let out = { ok: false };
  try {
    ws = new WebSocket(await connect());
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(p.method + ': ' + m.error.message)) : p.resolve(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || args.console)) {
          consoleLines.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
        }
        if (m.method === 'Runtime.exceptionThrown') {
          consoleLines.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 400));
        }
        for (let i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i].name === m.method) { const l = listeners.splice(i, 1)[0]; l.fn(m.params); }
        }
      }
    });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: parseFloat(args.scale || '1'), mobile: W < 700 });
    if (args.dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

    const user = args.user || cred.username;
    const pw = args.password || (args.user ? cred.demo_password : cred.password);

    // Reuse the stored session when it is still alive; log in when it is not.
    await navigate(`${BASE}/stats.do`);
    const loggedOut = await evaluate(`location.pathname.indexOf('login')!==-1 || !!document.getElementById('user_password')`);
    if (loggedOut || args.relogin) await login(user, pw);

    if (args.theme) {
      await navigate(`${BASE}/stats.do`);
      await evaluate(`localStorage.setItem('cmd-theme', ${JSON.stringify(args.theme)})`);
    }

    const t0 = Date.now();
    const url = args.url.startsWith('http') ? args.url : BASE + args.url;
    await navigate(url);
    out.loadMs = Date.now() - t0;
    if (args.wait) out.waitMs = await waitFor(args.wait, parseInt(args.timeout || '90000', 10));
    if (args.settle) await sleep(parseInt(args.settle, 10));
    out.timing = await evaluate(`(function(){var n=performance.getEntriesByType('navigation')[0]||{};
      var fcp=(performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime;
      return {ttfb:Math.round(n.responseStart||0), domContentLoaded:Math.round(n.domContentLoadedEventEnd||0),
              load:Math.round(n.loadEventEnd||0), fcp:fcp?Math.round(fcp):null,
              transfer:n.transferSize||0, decoded:n.decodedBodySize||0,
              marks:(window.__cmdMarks||null)};})()`);
    if (args.eval) out.eval = await evaluate(args.eval);
    // A second load in the same browser, so the same platform session: the only
    // honest way to measure what a returning viewer gets. A fresh Chrome is a
    // fresh login, and a fresh login has nothing remembered.
    if (args.reload) {
      const r0 = Date.now();
      await navigate(url);
      out.reloadMs = Date.now() - r0;
      if (args.wait) out.reloadWaitMs = await waitFor(args.wait, parseInt(args.timeout || '90000', 10));
      if (args.eval) out.reloadEval = await evaluate(args.eval);
    }
    if (args.clicks) {
      for (const sel of String(args.clicks).split('||')) {
        await evaluate(`(function(){var n=document.querySelector(${JSON.stringify(sel)}); if(n){n.click(); return true;} return false;})()`);
        await sleep(parseInt(args.clickwait || '1200', 10));
      }
      if (args.wait2) out.wait2Ms = await waitFor(args.wait2, 60000);
      if (args.eval2) out.eval2 = await evaluate(args.eval2);
    }
    if (args.shot) {
      let clip;
      if (args.full) {
        const m = await send('Page.getLayoutMetrics');
        const cs = m.cssContentSize || m.contentSize;
        clip = { x: 0, y: 0, width: W, height: Math.min(Math.ceil(cs.height), 16000), scale: 1 };
        await send('Emulation.setDeviceMetricsOverride', { width: W, height: clip.height, deviceScaleFactor: parseFloat(args.scale || '1'), mobile: false });
        await sleep(600);
      }
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!args.full, ...(clip ? { clip } : {}) });
      writeFileSync(args.shot, Buffer.from(shot.data, 'base64'));
      out.shot = args.shot;
    }
    out.url = await evaluate('location.href');
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message || e);
  } finally {
    out.console = consoleLines.slice(0, 30);
    console.log(JSON.stringify(out, null, 1));
    try { ws && ws.close(); } catch (e) { /* ignore */ }
    chrome.kill('SIGTERM');
    setTimeout(() => process.exit(out.ok ? 0 : 1), 300);
  }
})();
