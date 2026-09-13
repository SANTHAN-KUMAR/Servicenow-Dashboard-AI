/**
 * cmd_ceo. The CEO Dashboard: front page and navigation on one page.
 *
 * The server embeds the frame -- what the page is -- and this paints all of it at
 * once, then fills the numbers in as GlideAjax answers arrive (CmdCeoAjax). Nothing
 * waits for anything it does not need: the orbit, the pulse grid and the portfolio
 * cards are all on screen, shaped and labelled, before the first count returns.
 *
 * Sections, top to bottom:
 *   Overview    an orbit of the portfolios around the enterprise headline, the
 *               navigation the client's references draw, plus what moved.
 *   Pulse       Speed / Productivity / Risk across every portfolio -- the client's
 *               own Summary page, drawn so the portfolios can be compared.
 *   Portfolios  one portfolio's full slot set and its breakdown, opened in place.
 *   Trends      the flow of work over twelve months, from the same measures.
 *   Trust       how every number was counted, per table, for this viewer.
 *
 * Every mark comes from cmd_render's kit, so this reads as the same product.
 * ES5, no build step, loaded by src.
 */
(function () {
  'use strict';

  var R = window.CmdRender;
  if (!R || !R.kit) return;
  var K = R.kit, el = K.el, svgEl = K.svgEl;

  var SLOT_ORDER = ['Anchor1', 'Anchor2', 'Speed1', 'Speed2',
                    'Productivity1', 'Productivity2', 'Risk1', 'Risk2'];
  var SLOT_NAME = { Anchor: 'Anchor', Speed: 'Speed', Productivity: 'Productivity', Risk: 'Risk' };
  var PULSE = ['Speed1', 'Productivity1', 'Risk1'];
  var GEO = { w: 1000, h: 720, cx: 500, cy: 360, rx: 392, ry: 250, orb: 132, centre: 252 };

  var S = {
    frame: null, prefix: '', ajax: 'CmdCeoAjax',
    period: '30d', filters: [], focus: '',
    results: {}, meta: null, tables: {},
    seq: 0, loading: 0, errors: [], breakdown: {}, bdSeq: {},
    presenting: false, presentTimer: null, refreshTimer: null
  };
  var UI = {};
  var marks = window.__cmdMarks = { boot: Math.round(window.performance ? performance.now() : 0) };

  /* ── icons: hand-drawn stroke glyphs, 24-unit grid, no icon library ─────── */

  var ICON = {
    speed: 'M4 16a8 8 0 1 1 16 0 M12 16l4.5-5 M12 16h.01',
    productivity: 'M4 20h16 M7 16v-4 M12 16V7 M17 16v-7',
    risk: 'M12 3l7 3v5c0 4.6-3 8.1-7 10-4-1.9-7-5.4-7-10V6z M12 8.5v4.5 M12 16h.01',
    anchor: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
    filter: 'M4 5h16l-6.2 7.2V18l-3.6 2v-7.8z',
    refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4.5v5h-5',
    link: 'M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1 M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1',
    present: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
    download: 'M12 4v11 M7.5 10.5L12 15l4.5-4.5 M5 20h14',
    info: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M12 11v5.5 M12 7.8h.01',
    close: 'M6 6l12 12 M18 6L6 18',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
    ext: 'M14 4h6v6 M20 4l-8.5 8.5 M18 14v6H4V6h6',
    grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
    shield: 'M12 3l7 3v5c0 4.6-3 8.1-7 10-4-1.9-7-5.4-7-10V6z M9 12l2.2 2.2L15.5 10'
  };

  function icon(name, cls) {
    var s = svgEl('svg', { viewBox: '0 0 24 24', 'class': 'ic' + (cls ? ' ' + cls : ''),
                           'aria-hidden': 'true', focusable: 'false' });
    s.appendChild(svgEl('path', { d: ICON[name] || '' }));
    return s;
  }

  function slotFamily(slot) { return String(slot).replace(/\d+$/, ''); }
  function slotIcon(slot) {
    var f = slotFamily(slot);
    return f === 'Speed' ? 'speed' : f === 'Productivity' ? 'productivity' : f === 'Risk' ? 'risk' : 'anchor';
  }

  /* ── formatting ─────────────────────────────────────────────────────────── */

  function fmtNum(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var a = Math.abs(v);
    if (a >= 100000) return K.compact(v);
    if (a >= 1000) return K.fmt(v);
    if (a >= 100) return String(Math.round(v));
    if (a >= 10) return String(Math.round(v * 10) / 10);
    return String(Math.round(v * 100) / 100);
  }

  function unitText(unit) {
    return unit === '%' ? '%' : unit === 'd' ? 'd' : unit === 'h' ? 'h' : '';
  }

  function fmtVal(v, unit) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return fmtNum(v) + unitText(unit);
  }

  function valueNode(v, unit, cls) {
    var n = el('span', 'val' + (cls ? ' ' + cls : ''));
    if (v === null || v === undefined || isNaN(v)) {
      n.appendChild(el('span', 'n none', '—'));
      return n;
    }
    n.appendChild(el('span', 'n', fmtNum(v)));
    var u = unitText(unit);
    if (u) n.appendChild(el('span', 'u', u));
    return n;
  }

  function periodObj(key) {
    var ps = S.frame.periods;
    for (var i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
    return ps[2];
  }

  /** "vs 1,443 thirty days ago", "vs 366 in the 30 days before". */
  function prevPhrase(r) {
    var P = periodObj(S.period);
    if (!r || !r.delta) return '';
    if (r.kind === 'event') return 'vs ' + fmtVal(r.delta.prev, r.unit) + ' in ' + P.prev;
    return 'vs ' + fmtVal(r.delta.prev, r.unit) + ' ' + (P.days === 1 ? 'yesterday' : P.days + ' days ago');
  }

  function deltaChip(r) {
    var d = r ? r.delta : null;
    var c = el('span', 'dl');
    if (!d) { c.className = 'dl none'; return c; }
    var cls = d.abs === 0 ? 'flat' : d.better === true ? 'good' : d.better === false ? 'bad' : 'neutral';
    c.className = 'dl ' + cls;
    var arrow = d.abs > 0 ? '▲' : d.abs < 0 ? '▼' : '■';
    var txt;
    if (r.unit === '%') {
      txt = (d.abs > 0 ? '+' : '') + fmtNum(d.abs) + ' pts';
    } else if (d.rel !== null && d.rel !== undefined) {
      var p = Math.abs(d.rel) * 100;
      txt = (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + '%';
    } else {
      txt = (d.abs > 0 ? '+' : '') + fmtVal(d.abs, r.unit);
    }
    c.appendChild(el('span', 'a', arrow));
    c.appendChild(el('span', 't', txt));
    c.title = prevPhrase(r) + (d.better === null ? '' : d.better ? ' — better' : ' — worse');
    return c;
  }

  function trendOf(r) {
    if (!r) return null;
    var useDays = r.kind === 'event' && r.days && (S.period === 'today' || S.period === '7d' || S.period === '30d');
    var arr = useDays ? r.days : r.months;
    if (!arr || !arr.length) return null;
    var counts = [], any = false;
    for (var i = 0; i < arr.length; i++) {
      var x = arr[i] === null || arr[i] === undefined ? 0 : arr[i];
      counts.push(x);
      if (x) any = true;
    }
    if (!any) return null;
    var periods = [];
    for (var j = 0; j < counts.length; j++) periods.push({ partial: j === counts.length - 1 });
    return { counts: counts, periods: periods, label: useDays ? 'last 30 days, daily' : 'last 12 months, monthly' };
  }

  function res(id) { return id ? S.results[id] || null : null; }
  function ind(id) { return (S.frame.indicators || {})[id] || { name: 'Unknown measure', unit: '' }; }

  /* ── URLs and state ─────────────────────────────────────────────────────── */

  function page(name) { return S.prefix + name + '.do'; }

  function filterStr(filters) {
    var f = filters || S.filters, out = [];
    for (var i = 0; i < f.length; i++) out.push(f[i].field + ':' + f[i].values.join(','));
    return out.join('|');
  }

  function stateUrl() {
    var q = ['period=' + encodeURIComponent(S.period)];
    var fs = filterStr();
    if (fs) q.push('f=' + encodeURIComponent(fs));
    if (S.focus) q.push('focus=' + encodeURIComponent(S.focus));
    return page('cmd_ceo') + '?' + q.join('&');
  }

  function syncUrl() {
    try { window.history.replaceState(null, '', stateUrl()); } catch (e) { /* not fatal */ }
  }

  /** Single-valued filters travel into an analysis as drill steps. */
  function filterPath(extra) {
    var parts = [];
    for (var i = 0; i < S.filters.length; i++) {
      if (S.filters[i].values.length === 1) {
        parts.push(encodeURIComponent(S.filters[i].field) + ':' + encodeURIComponent(S.filters[i].values[0]));
      }
    }
    if (extra) parts.push(encodeURIComponent(extra.field) + ':' + encodeURIComponent(extra.key));
    return parts.length ? '&path=' + encodeURIComponent(parts.join('|')) : '';
  }

  function analysisUrl(portfolio, id, extra) {
    return page('cmd_dashboard') + '?portfolio=' + encodeURIComponent(portfolio) +
           '&measure=' + encodeURIComponent(id) + '&period=' + encodeURIComponent(S.period) +
           filterPath(extra);
  }

  /* ── data ───────────────────────────────────────────────────────────────── */

  function ajax(method, params, cb) {
    if (typeof window.GlideAjax === 'undefined') {
      cb({ error: 'This page cannot reach the server: GlideAjax is not loaded.' });
      return;
    }
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      cb({ error: 'The server took longer than 90 seconds to answer.' });
    }, 90000);
    var ga = new window.GlideAjax(S.ajax);
    ga.addParam('sysparm_name', method);
    for (var k in params) if (params.hasOwnProperty(k)) ga.addParam(k, params[k]);
    ga.getXMLAnswer(function (answer) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      var o;
      try { o = JSON.parse(answer); } catch (e) {
        o = { error: 'The server answered with something that is not data.' };
      }
      cb(o || { error: 'The server returned nothing.' });
    });
  }

  function absorb(o) {
    if (!o || !o.results) return;
    for (var id in o.results) if (o.results.hasOwnProperty(id)) S.results[id] = o.results[id];
    for (var t in o.tables) if (o.tables.hasOwnProperty(t)) S.tables[t] = o.tables[t];
    S.meta = {
      period: o.period, periodLabel: o.periodLabel, prevLabel: o.prevLabel,
      monthLabels: o.monthLabels, dayKeys: o.dayKeys, today: o.today,
      generated: o.generated, computeMs: Math.max(o.computeMs || 0, S.meta ? S.meta.computeMs || 0 : 0),
      cached: o.cached, ageMs: o.ageMs || 0
    };
  }

  function load(nocache) {
    var seq = ++S.seq;
    S.errors = [];
    var groups = S.frame.groups || [];
    S.loading = groups.length;
    setBusy(true);
    var params = { sysparm_period: S.period, sysparm_filters: filterStr(),
                   sysparm_nocache: nocache ? '1' : '' };
    var t0 = window.performance ? performance.now() : 0;
    for (var i = 0; i < groups.length; i++) {
      (function (g) {
        var p = {};
        for (var k in params) if (params.hasOwnProperty(k)) p[k] = params[k];
        p.sysparm_ids = g.ids.join(',');
        ajax('measures', p, function (o) {
          if (seq !== S.seq) return;
          if (o.error) S.errors.push(o.error);
          else absorb(o);
          if (!marks.firstData && !o.error) marks.firstData = Math.round(performance.now());
          marks['g_' + g.name] = { server: o.serverMs, compute: o.computeMs, cached: !!o.cached,
                                   rt: Math.round((window.performance ? performance.now() : 0) - t0) };
          S.loading--;
          paintValues();
          if (S.loading <= 0) {
            marks.allData = Math.round(performance.now());
            marks.roundTrip = Math.round(performance.now() - t0);
            setBusy(false);
            window.__cmdCeoReady = true;
          }
        });
      })(groups[i]);
    }
    loadBreakdown(S.focus, nocache);
  }

  function loadBreakdown(key, nocache) {
    if (!key) return;
    var p = portfolioBy(key);
    if (!p || !p.breakdown) { S.breakdown[key] = { none: true }; paintBreakdown(); return; }
    var sig = S.period + '|' + filterStr();
    if (!nocache && S.breakdown[key] && S.breakdown[key].sig === sig) { paintBreakdown(); return; }
    var seq = (S.bdSeq[key] || 0) + 1;
    S.bdSeq[key] = seq;
    S.breakdown[key] = { loading: true, sig: sig };
    paintBreakdown();
    ajax('breakdown', { sysparm_portfolio: key, sysparm_period: S.period, sysparm_filters: filterStr() },
      function (o) {
        if (S.bdSeq[key] !== seq) return;
        o.sig = sig;
        S.breakdown[key] = o;
        if (key === S.focus) paintBreakdown();
      });
  }

  function portfolioBy(key) {
    var ps = S.frame.portfolios;
    for (var i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
    return null;
  }

  function slotId(p, slot) {
    for (var i = 0; i < p.slots.length; i++) if (p.slots[i].slot === slot) return p.slots[i].id;
    return null;
  }

  function pip(r) {
    if (!r) return 'wait';
    if (!r.ok || r.value === null) return 'none';
    if (!r.delta || r.delta.abs === 0) return 'flat';
    return r.delta.better === true ? 'good' : r.delta.better === false ? 'bad' : 'flat';
  }

  function portfolioStatus(p) {
    var bad = 0, good = 0, wait = 0;
    for (var i = 0; i < PULSE.length; i++) {
      var s = pip(res(slotId(p, PULSE[i])));
      if (s === 'bad') bad++;
      if (s === 'good') good++;
      if (s === 'wait') wait++;
    }
    if (wait) return 'wait';
    if (bad >= 2) return 'bad';
    if (bad === 0 && good > 0) return 'good';
    return 'mixed';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     The page
     ══════════════════════════════════════════════════════════════════════════ */

  function render(mount) {
    mount.innerHTML = '';
    mount.appendChild(K.gradients());

    var f = S.frame;
    if (f.error || f.denied) { mount.appendChild(closedPage(f)); return; }

    var pageEl = el('div', 'ceo-page');
    pageEl.appendChild(topBar());
    UI.chips = el('div', 'fchips');
    pageEl.appendChild(UI.chips);
    UI.status = el('div', 'ceo-status');
    UI.status.setAttribute('role', 'status');
    UI.status.setAttribute('aria-live', 'polite');
    pageEl.appendChild(UI.status);

    pageEl.appendChild(overviewSection());
    pageEl.appendChild(pulseSection());
    pageEl.appendChild(portfoliosSection());
    pageEl.appendChild(trendsSection());
    pageEl.appendChild(trustSection());
    pageEl.appendChild(footer());
    mount.appendChild(pageEl);

    mount.appendChild(drawer());
    UI.toast = el('div', 'toast');
    UI.toast.setAttribute('role', 'status');
    mount.appendChild(UI.toast);
    UI.pop = el('div', 'ipop');
    UI.pop.setAttribute('role', 'dialog');
    mount.appendChild(UI.pop);

    K.tooltipLayer(mount);
    wireScrollSpy();
    wireKeys();
    paintChips();
    paintValues();
  }

  function closedPage(f) {
    var box = el('div', 'ceo-closed');
    var card = el('div', 'panel pad');
    card.appendChild(icon(f.denied ? 'shield' : 'info', 'big'));
    card.appendChild(el('div', 'eyebrow', 'CEO Dashboard'));
    if (f.denied) {
      card.appendChild(el('h1', 'd2', 'This dashboard is for leadership roles'));
      card.appendChild(el('p', 'sm', 'Opening it needs the ' + f.role + ' role. Your ' +
        'administrator can grant it. The role opens the page; it grants no data. Every ' +
        'number on it is still counted against your own access.'));
    } else {
      card.appendChild(el('h1', 'd2', 'The dashboard could not be built'));
      card.appendChild(el('p', 'sm', f.error));
    }
    var a = el('a', 'btn', 'Open the analytics catalog');
    a.href = page('cmd_catalog');
    card.appendChild(a);
    box.appendChild(card);
    return box;
  }

  /* ── top bar ────────────────────────────────────────────────────────────── */

  function iconBtn(name, label, onClick, cls) {
    var b = el('button', 'ibtn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(name));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function topBar() {
    var bar = el('header', 'ceo-bar');
    var l = el('div', 'bar-l');
    var brand = el('a', 'brand');
    brand.href = page('cmd_catalog');
    brand.title = 'All dashboards';
    var mark = el('span', 'mark');
    mark.appendChild(icon('grid'));
    brand.appendChild(mark);
    var bt = el('span', 'brand-t');
    bt.appendChild(el('span', 'b1', 'COMMAND'));
    bt.appendChild(el('span', 'b2', 'CEO Dashboard'));
    brand.appendChild(bt);
    l.appendChild(brand);

    var nav = el('nav', 'bar-nav');
    nav.setAttribute('aria-label', 'Sections');
    var secs = [['ceo-overview', 'Overview'], ['ceo-pulse', 'Pulse'], ['ceo-portfolios', 'Portfolios'],
                ['ceo-trends', 'Trends'], ['ceo-trust', 'Trust']];
    UI.navLinks = {};
    for (var i = 0; i < secs.length; i++) {
      var a = el('a', 'nl', secs[i][1]);
      a.href = '#' + secs[i][0];
      a.setAttribute('data-sec', secs[i][0]);
      a.addEventListener('click', navClick);
      UI.navLinks[secs[i][0]] = a;
      nav.appendChild(a);
    }
    l.appendChild(nav);
    bar.appendChild(l);

    var r = el('div', 'bar-r');
    var seg = el('div', 'seg period');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Period');
    UI.periodBtns = [];
    for (var p = 0; p < S.frame.periods.length; p++) {
      (function (P) {
        var b = el('button', null, P.short);
        b.type = 'button';
        b.title = P.label;
        b.setAttribute('data-p', P.key);
        b.addEventListener('click', function () { setPeriod(P.key); });
        UI.periodBtns.push(b);
        seg.appendChild(b);
      })(S.frame.periods[p]);
    }
    r.appendChild(seg);

    UI.filterBtn = el('button', 'btn fbtn');
    UI.filterBtn.type = 'button';
    UI.filterBtn.appendChild(icon('filter'));
    UI.filterBtn.appendChild(el('span', '', 'Filters'));
    UI.filterCount = el('span', 'cnt', '');
    UI.filterBtn.appendChild(UI.filterCount);
    UI.filterBtn.addEventListener('click', openDrawer);
    r.appendChild(UI.filterBtn);

    UI.refresh = iconBtn('refresh', 'Refresh the numbers now', function () { load(true); }, 'refresh');
    r.appendChild(UI.refresh);
    UI.asof = el('span', 'asof', '');
    r.appendChild(UI.asof);
    r.appendChild(iconBtn('link', 'Copy a link to exactly this view', share));
    r.appendChild(iconBtn('present', 'Present: full screen, cycling through the sections', togglePresent));

    var ex = el('div', 'menu');
    var exb = iconBtn('download', 'Export', null);
    exb.setAttribute('aria-haspopup', 'true');
    var exm = el('div', 'menu-m');
    var pdf = el('button', null, 'PDF, via print');
    pdf.type = 'button';
    pdf.addEventListener('click', function () { closeMenus(); window.print(); });
    var csv = el('button', null, 'CSV, every measure');
    csv.type = 'button';
    csv.addEventListener('click', function () { closeMenus(); downloadCsv(); });
    exm.appendChild(pdf);
    exm.appendChild(csv);
    exb.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !ex.classList.contains('open');
      closeMenus();
      if (open) ex.classList.add('open');
    });
    ex.appendChild(exb);
    ex.appendChild(exm);
    r.appendChild(ex);
    r.appendChild(K.themeToggle());
    bar.appendChild(r);
    return bar;
  }

  function closeMenus() {
    var ms = document.querySelectorAll('#cmd-wrap .menu.open');
    for (var i = 0; i < ms.length; i++) ms[i].classList.remove('open');
  }

  function navClick(e) {
    var id = this.getAttribute('data-sec');
    var t = document.getElementById(id);
    if (!t) return;
    e.preventDefault();
    scrollToEl(t);
  }

  function scrollToEl(t) {
    var y = t.getBoundingClientRect().top + (window.pageYOffset || 0) - 78;
    try { window.scrollTo({ top: y, behavior: reducedMotion() ? 'auto' : 'smooth' }); }
    catch (e) { window.scrollTo(0, y); }
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function setBusy(on) {
    var w = document.getElementById('cmd-wrap');
    if (w) w.classList.toggle('busy', !!on);
    if (UI.refresh) UI.refresh.classList.toggle('spin', !!on);
  }

  function setPeriod(key) {
    if (key === S.period) return;
    S.period = key;
    syncUrl();
    paintPeriod();
    load(false);
  }

  function paintPeriod() {
    for (var i = 0; i < UI.periodBtns.length; i++) {
      UI.periodBtns[i].setAttribute('aria-selected',
        String(UI.periodBtns[i].getAttribute('data-p') === S.period));
    }
  }

  /* ── overview: the orbit ────────────────────────────────────────────────── */

  function section(id, eyebrow, title, lead) {
    var s = el('section', 'sec');
    s.id = id;
    var h = el('div', 'sec-h');
    h.appendChild(el('div', 'eyebrow', eyebrow));
    h.appendChild(el('h2', 'sec-t', title));
    if (lead) h.appendChild(el('p', 'sec-l', lead));
    s.appendChild(h);
    return s;
  }

  function overviewSection() {
    var s = el('section', 'sec hero');
    s.id = 'ceo-overview';
    var grid = el('div', 'hero-g');

    var left = el('div', 'hero-l');
    left.appendChild(el('div', 'eyebrow', 'Control tower · Enterprise overview'));
    left.appendChild(el('h1', 'hero-t', 'CEO Dashboard'));
    UI.heroLead = el('p', 'hero-lead', '');
    left.appendChild(UI.heroLead);
    UI.heroStats = el('div', 'hero-stats');
    left.appendChild(UI.heroStats);
    UI.moves = el('div', 'moves panel');
    left.appendChild(UI.moves);
    grid.appendChild(left);

    grid.appendChild(orbit());
    s.appendChild(grid);
    return s;
  }

  function orbPos(i, n) {
    var a = -Math.PI / 2 + i * 2 * Math.PI / n;
    return { x: GEO.cx + GEO.rx * Math.cos(a), y: GEO.cy + GEO.ry * Math.sin(a), a: a };
  }

  function orbit() {
    var wrap = el('div', 'orbit');
    wrap.setAttribute('role', 'navigation');
    wrap.setAttribute('aria-label', 'Portfolios');
    var ps = S.frame.portfolios, n = ps.length;

    var s = svgEl('svg', { viewBox: '0 0 ' + GEO.w + ' ' + GEO.h, 'class': 'orbit-bg',
                           preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
    var defs = svgEl('defs');
    var core = svgEl('radialGradient', { id: 'ceoCore', cx: '50%', cy: '50%', r: '50%' });
    core.appendChild(svgEl('stop', { offset: '0%', style: 'stop-color:var(--glow-1);stop-opacity:.55' }));
    core.appendChild(svgEl('stop', { offset: '55%', style: 'stop-color:var(--glow-1);stop-opacity:.10' }));
    core.appendChild(svgEl('stop', { offset: '100%', style: 'stop-color:var(--glow-1);stop-opacity:0' }));
    defs.appendChild(core);
    var ringG = svgEl('linearGradient', { id: 'ceoRing', x1: 0, y1: 0, x2: 1, y2: 1 });
    ringG.appendChild(svgEl('stop', { offset: '0%', style: 'stop-color:var(--glow-2)' }));
    ringG.appendChild(svgEl('stop', { offset: '100%', style: 'stop-color:var(--glow-1)' }));
    defs.appendChild(ringG);
    s.appendChild(defs);

    s.appendChild(svgEl('ellipse', { cx: GEO.cx, cy: GEO.cy, rx: GEO.rx * 0.82, ry: GEO.ry * 0.9,
                                      fill: 'url(#ceoCore)' }));
    s.appendChild(svgEl('ellipse', { cx: GEO.cx, cy: GEO.cy, rx: GEO.rx + 70, ry: GEO.ry + 62, 'class': 'ring faint' }));
    s.appendChild(svgEl('ellipse', { cx: GEO.cx, cy: GEO.cy, rx: GEO.rx - 150, ry: GEO.ry - 96, 'class': 'ring faint' }));
    UI.spokes = {};
    for (var i = 0; i < n; i++) {
      var p = orbPos(i, n);
      var sp = svgEl('line', { x1: GEO.cx, y1: GEO.cy, x2: p.x, y2: p.y, 'class': 'spoke' });
      UI.spokes[ps[i].key] = sp;
      s.appendChild(sp);
    }
    s.appendChild(svgEl('ellipse', { cx: GEO.cx, cy: GEO.cy, rx: GEO.rx, ry: GEO.ry, 'class': 'ring main' }));
    s.appendChild(svgEl('ellipse', { cx: GEO.cx, cy: GEO.cy, rx: GEO.rx, ry: GEO.ry, 'class': 'ring flow' }));
    wrap.appendChild(s);

    /* The centre: the enterprise headline, with a gauge of where it sits in its
       own twelve-month range. */
    var c = el('div', 'orb centre');
    c.style.left = (GEO.cx / GEO.w * 100) + '%';
    c.style.top = (GEO.cy / GEO.h * 100) + '%';
    c.style.width = (GEO.centre / GEO.w * 100) + '%';
    var gauge = svgEl('svg', { viewBox: '0 0 100 100', 'class': 'gauge', 'aria-hidden': 'true' });
    gauge.appendChild(svgEl('path', { d: arcPath(50, 50, 46.5, -120, 120), 'class': 'g-track' }));
    UI.gaugeVal = svgEl('path', { d: arcPath(50, 50, 46.5, -120, -119.9), 'class': 'g-val' });
    gauge.appendChild(UI.gaugeVal);
    c.appendChild(gauge);
    var ci = el('div', 'orb-in');
    UI.cLabel = el('div', 'o-l', ind(S.frame.headline).name);
    ci.appendChild(UI.cLabel);
    UI.cVal = el('div', 'o-v', '');
    ci.appendChild(UI.cVal);
    UI.cSub = el('div', 'o-s', '');
    ci.appendChild(UI.cSub);
    UI.cRange = el('div', 'o-r', '');
    ci.appendChild(UI.cRange);
    c.appendChild(ci);
    wrap.appendChild(c);

    UI.orbs = {};
    for (var j = 0; j < n; j++) {
      (function (P, pos) {
        var o = el('button', 'orb sat' + (P.duplicate ? ' dup' : ''));
        o.type = 'button';
        o.style.left = (pos.x / GEO.w * 100) + '%';
        o.style.top = (pos.y / GEO.h * 100) + '%';
        o.style.width = (GEO.orb / GEO.w * 100) + '%';
        o.setAttribute('data-key', P.key);
        var inner = el('span', 'orb-in');
        inner.appendChild(el('span', 'o-l', P.label));
        var v = el('span', 'o-v', '');
        inner.appendChild(v);
        var pips = el('span', 'pips');
        var pipEls = [];
        for (var k = 0; k < PULSE.length; k++) {
          var pp = el('span', 'pip wait');
          pp.setAttribute('data-f', slotFamily(PULSE[k]).charAt(0));
          pipEls.push(pp);
          pips.appendChild(pp);
        }
        inner.appendChild(pips);
        o.appendChild(inner);
        var cap = el('span', 'o-cap', P.duplicate ? 'one measure, repeated' : P.subtitle);
        o.appendChild(cap);
        o.addEventListener('click', function () { focusPortfolio(P.key, true); });
        o.addEventListener('mouseenter', function () { hoverSpoke(P.key, true); });
        o.addEventListener('mouseleave', function () { hoverSpoke(P.key, false); });
        o.addEventListener('focus', function () { hoverSpoke(P.key, true); });
        o.addEventListener('blur', function () { hoverSpoke(P.key, false); });
        UI.orbs[P.key] = { node: o, val: v, pips: pipEls };
        wrap.appendChild(o);
      })(ps[j], orbPos(j, n));
    }
    UI.orbit = wrap;
    return wrap;
  }

  function hoverSpoke(key, on) {
    var sp = UI.spokes[key];
    if (sp) sp.setAttribute('class', 'spoke' + (on || key === S.focus ? ' on' : ''));
  }

  function arcPath(cx, cy, r, a0, a1) {
    var rad = function (a) { return (a - 90) * Math.PI / 180; };
    var x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
    var x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
    var large = (a1 - a0) > 180 ? 1 : 0;
    return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' +
           x1.toFixed(2) + ' ' + y1.toFixed(2);
  }

  function paintOrbit() {
    var h = res(S.frame.headline), hi = ind(S.frame.headline);
    UI.cVal.innerHTML = '';
    if (!h) {
      UI.cVal.appendChild(el('span', 'skel-line'));
      UI.cSub.textContent = '';
      UI.cRange.textContent = '';
    } else {
      UI.cVal.appendChild(valueNode(h.value, h.unit));
      UI.cSub.innerHTML = '';
      if (h.delta) {
        UI.cSub.appendChild(deltaChip(h));
        UI.cSub.appendChild(el('span', 'o-sp', h.kind === 'event' ? periodObj(S.period).label : 'now'));
      } else {
        UI.cSub.appendChild(el('span', 'o-sp', h.ok ? (h.kind === 'event' ? periodObj(S.period).label : 'now') : h.why || ''));
      }
      var m = h.months;
      if (m && m.length && h.value !== null) {
        var lo = Infinity, hiV = -Infinity;
        for (var i = 0; i < m.length; i++) {
          if (m[i] === null) continue;
          if (m[i] < lo) lo = m[i];
          if (m[i] > hiV) hiV = m[i];
        }
        var frac = hiV > lo ? (h.value - lo) / (hiV - lo) : 1;
        frac = Math.max(0.01, Math.min(1, frac));
        UI.gaugeVal.setAttribute('d', arcPath(50, 50, 46.5, -120, -120 + 240 * frac));
        UI.gaugeVal.setAttribute('class', 'g-val ' + (h.delta && h.delta.better === false ? 'bad' : h.delta && h.delta.better ? 'good' : ''));
        UI.cRange.textContent = '12-month range ' + fmtVal(lo, h.unit) + ' – ' + fmtVal(hiV, h.unit);
      }
    }
    UI.cLabel.textContent = hi.name;

    var ps = S.frame.portfolios;
    for (var j = 0; j < ps.length; j++) {
      var P = ps[j], O = UI.orbs[P.key];
      var anchorId = slotId(P, 'Anchor1') || (P.slots[0] && P.slots[0].id);
      var r = res(anchorId);
      O.val.innerHTML = '';
      if (!r) O.val.appendChild(el('span', 'skel-line sm'));
      else O.val.appendChild(valueNode(r.value, r.unit));
      var tipLines = [P.label + (P.named ? '' : ' · ' + P.subtitle)];
      tipLines.push(ind(anchorId).name + ': ' + (r ? fmtVal(r.value, r.unit) : '…'));
      for (var k = 0; k < PULSE.length; k++) {
        var sid = slotId(P, PULSE[k]);
        var rr = res(sid);
        var st = pip(rr);
        O.pips[k].className = 'pip ' + st;
        O.pips[k].title = slotFamily(PULSE[k]) + ': ' + (rr ? fmtVal(rr.value, rr.unit) : '…');
        tipLines.push(slotFamily(PULSE[k]) + ' · ' + ind(sid).name + ': ' +
                      (rr ? fmtVal(rr.value, rr.unit) + (rr.delta ? '  (' + prevPhrase(rr) + ')' : '') : '…'));
      }
      if (P.duplicate) tipLines.push('Every slot of this portfolio is one indicator in the source configuration.');
      O.node.setAttribute('data-tip', tipLines.join('\n'));
      O.node.setAttribute('aria-label', tipLines.join('. ') + '. Open this portfolio.');
      O.node.setAttribute('data-status', portfolioStatus(P));
      O.node.classList.toggle('sel', P.key === S.focus);
      hoverSpoke(P.key, false);
    }
  }

  /* What moved, across every distinct measure on the page, judged by each
     indicator's own direction. A rule, not a model: the largest relative moves,
     worse first, because the page's first job is to say where to look. */
  function paintMoves() {
    var box = UI.moves;
    box.innerHTML = '';
    var used = {}, list = [], ps = S.frame.portfolios, i, j;
    for (i = 0; i < ps.length; i++) {
      for (j = 0; j < ps[i].slots.length; j++) {
        var id = ps[i].slots[j].id;
        if (!used[id]) { used[id] = []; }
        used[id].push(ps[i]);
      }
    }
    var good = 0, bad = 0, flat = 0, waiting = 0;
    for (var id2 in used) {
      if (!used.hasOwnProperty(id2)) continue;
      var r = res(id2);
      if (!r) { waiting++; continue; }
      if (!r.ok || r.value === null || !r.delta) continue;
      if (r.delta.better === true) good++;
      else if (r.delta.better === false) bad++;
      else flat++;
      if (r.delta.better === null || r.delta.abs === 0) continue;
      var score = r.delta.rel !== null && r.delta.rel !== undefined ? Math.abs(r.delta.rel)
                : (r.unit === '%' ? Math.abs(r.delta.abs) / 100 : 1);
      list.push({ id: id2, r: r, score: score, ps: used[id2] });
    }

    var head = el('div', 'moves-h');
    head.appendChild(el('div', 'h3', 'What moved'));
    head.appendChild(el('div', 'moves-s', 'Against ' + periodObj(S.period).prev + ', judged by each measure’s own direction'));
    box.appendChild(head);
    if (waiting && !list.length) {
      for (var sk = 0; sk < 4; sk++) box.appendChild(el('div', 'skel-block mv-skel'));
      return;
    }
    var tally = el('div', 'tally');
    tally.appendChild(tallyItem(bad, 'worse', 'bad'));
    tally.appendChild(tallyItem(good, 'better', 'good'));
    tally.appendChild(tallyItem(flat, 'steady or neutral', 'flat'));
    box.appendChild(tally);

    list.sort(function (a, b) {
      if (a.r.delta.better !== b.r.delta.better) return a.r.delta.better ? 1 : -1;
      return b.score - a.score;
    });
    var worse = [], better = [];
    for (i = 0; i < list.length; i++) (list[i].r.delta.better ? better : worse).push(list[i]);
    var pick = worse.slice(0, 3).concat(better.slice(0, 2));
    if (!pick.length) {
      box.appendChild(el('p', 'sm', 'Nothing measurable changed against the previous period.'));
      return;
    }
    var ul = el('div', 'mv-list');
    for (i = 0; i < pick.length; i++) {
      (function (it) {
        var row = el('button', 'mv ' + (it.r.delta.better ? 'good' : 'bad'));
        row.type = 'button';
        var t = el('span', 'mv-t');
        t.appendChild(el('span', 'mv-n', it.r.name));
        var where = [];
        for (var q = 0; q < it.ps.length && q < 3; q++) where.push(it.ps[q].label);
        if (it.ps.length > 3) where.push('+' + (it.ps.length - 3));
        t.appendChild(el('span', 'mv-w', where.join(', ')));
        row.appendChild(t);
        var v = el('span', 'mv-v');
        v.appendChild(el('span', 'mv-now', fmtVal(it.r.value, it.r.unit)));
        v.appendChild(deltaChip(it.r));
        row.appendChild(v);
        row.title = prevPhrase(it.r);
        row.addEventListener('click', function () {
          focusPortfolio(it.ps[0].key, true, it.id);
        });
        ul.appendChild(row);
      })(pick[i]);
    }
    box.appendChild(ul);
  }

  function tallyItem(n, label, cls) {
    var d = el('div', 'ti ' + cls);
    d.appendChild(el('span', 'ti-n', String(n)));
    d.appendChild(el('span', 'ti-l', label));
    return d;
  }

  function paintHero() {
    var f = S.frame, nMeasures = 0, seen = {};
    for (var i = 0; i < f.portfolios.length; i++) {
      for (var j = 0; j < f.portfolios[i].slots.length; j++) {
        var id = f.portfolios[i].slots[j].id;
        if (!seen[id]) { seen[id] = true; nMeasures++; }
      }
    }
    var P = periodObj(S.period);
    UI.heroLead.textContent = f.portfolios.length + ' portfolios and ' + nMeasures +
      ' distinct measures on one page, over ' + P.label.toLowerCase() +
      '. Every number is counted live against your own access.';
    UI.heroStats.innerHTML = '';
    var worst = 'VERIFIED', rank = { VERIFIED: 0, FILTERED: 1, BOUNDED: 2, DENIED: 3 }, nt = 0;
    for (var t in S.tables) {
      if (!S.tables.hasOwnProperty(t)) continue;
      nt++;
      if (rank[S.tables[t].mode] > rank[worst]) worst = S.tables[t].mode;
    }
    UI.heroStats.appendChild(stat(String(f.portfolios.length), 'portfolios'));
    UI.heroStats.appendChild(stat(String(nMeasures), 'measures'));
    UI.heroStats.appendChild(stat(nt ? String(nt) : '…', 'tables checked'));
    var chipWrap = el('div', 'hs chipw');
    chipWrap.appendChild(nt ? K.aclChip({ mode: worst, delta: 0 }) : el('span', 'chip', 'checking access…'));
    UI.heroStats.appendChild(chipWrap);
  }

  function stat(v, l) {
    var d = el('div', 'hs');
    d.appendChild(el('span', 'hs-v', v));
    d.appendChild(el('span', 'hs-l', l));
    return d;
  }

  /* ── pulse ──────────────────────────────────────────────────────────────── */

  function pulseSection() {
    var s = section('ceo-pulse', 'Pulse', 'Speed, productivity and risk, portfolio by portfolio',
      'The three measures the source Summary page shows for every portfolio, side by side so they can be compared, each with its change and its history.');
    UI.pulse = el('div', 'pulse');
    s.appendChild(UI.pulse);
    return s;
  }

  function paintPulse() {
    var g = UI.pulse;
    g.innerHTML = '';
    var head = el('div', 'pr ph');
    head.appendChild(el('div', 'pc pn', 'Portfolio'));
    for (var h = 0; h < PULSE.length; h++) {
      var hc = el('div', 'pc');
      hc.appendChild(icon(slotIcon(PULSE[h])));
      hc.appendChild(el('span', '', SLOT_NAME[slotFamily(PULSE[h])]));
      head.appendChild(hc);
    }
    g.appendChild(head);
    var ps = S.frame.portfolios;
    for (var i = 0; i < ps.length; i++) {
      (function (P) {
        var row = el('div', 'pr' + (P.key === S.focus ? ' sel' : '') + (P.duplicate ? ' dup' : ''));
        var name = el('button', 'pc pn');
        name.type = 'button';
        name.appendChild(el('span', 'st st-' + portfolioStatus(P)));
        var nt = el('span', 'pn-t');
        nt.appendChild(el('span', 'pn-l', P.label));
        nt.appendChild(el('span', 'pn-s', P.duplicate ? 'one indicator in every slot, as configured' : P.subtitle));
        name.appendChild(nt);
        name.addEventListener('click', function () { focusPortfolio(P.key, true); });
        row.appendChild(name);
        for (var k = 0; k < PULSE.length; k++) {
          var id = slotId(P, PULSE[k]);
          row.appendChild(pulseCell(P, PULSE[k], id));
        }
        g.appendChild(row);
      })(ps[i]);
    }
  }

  function pulseCell(P, slot, id) {
    var c = el('button', 'pc cell');
    c.type = 'button';
    if (!id) {
      c.appendChild(el('span', 'cl-n muted', 'not configured'));
      c.disabled = true;
      return c;
    }
    var r = res(id);
    c.appendChild(el('span', 'cl-n', ind(id).name));
    var line = el('span', 'cl-v');
    if (!r) {
      line.appendChild(el('span', 'skel-line sm'));
    } else {
      line.appendChild(valueNode(r.value, r.unit));
      line.appendChild(deltaChip(r));
    }
    c.appendChild(line);
    var tr = trendOf(r);
    if (tr) {
      var sp = el('span', 'cl-sp');
      sp.appendChild(K.sparkline(tr.counts, tr.periods));
      c.appendChild(sp);
    } else if (r && !r.ok) {
      c.appendChild(el('span', 'cl-why', r.why || ''));
    } else if (r && r.value === null) {
      c.appendChild(el('span', 'cl-why', r.why || ''));
    }
    c.title = (r && r.delta ? prevPhrase(r) + '. ' : '') + 'Open ' + P.label;
    c.addEventListener('click', function () { focusPortfolio(P.key, true, id, slot); });
    return c;
  }

  /* ── portfolios ─────────────────────────────────────────────────────────── */

  function portfoliosSection() {
    var s = section('ceo-portfolios', 'Portfolios', 'Every slot, in place',
      'Choose a portfolio on the orbit, the pulse or the tabs. Its full set of measures opens here, with the breakdown the source dashboard applies to it.');
    var tabs = el('div', 'ptabs');
    tabs.setAttribute('role', 'tablist');
    UI.tabs = {};
    var ps = S.frame.portfolios;
    for (var i = 0; i < ps.length; i++) {
      (function (P) {
        var t = el('button', 'ptab');
        t.type = 'button';
        t.setAttribute('role', 'tab');
        t.appendChild(el('span', 'st st-wait'));
        var tt = el('span', 'pt-t');
        tt.appendChild(el('span', 'pt-l', P.label));
        tt.appendChild(el('span', 'pt-s', P.subtitle));
        t.appendChild(tt);
        t.addEventListener('click', function () { focusPortfolio(P.key, false); });
        UI.tabs[P.key] = t;
        tabs.appendChild(t);
      })(ps[i]);
    }
    s.appendChild(tabs);
    UI.pbody = el('div', 'pbody');
    s.appendChild(UI.pbody);
    return s;
  }

  function focusPortfolio(key, scroll, cardId, slot) {
    var changed = key !== S.focus;
    S.focus = key;
    syncUrl();
    if (changed) loadBreakdown(key, false);
    paintValues();
    if (scroll) {
      var target = null;
      if (slot) target = document.getElementById('kc-' + key + '-' + slot);
      else if (cardId) {
        var P = portfolioBy(key);
        for (var i = 0; P && i < P.slots.length; i++) {
          if (P.slots[i].id === cardId) { target = document.getElementById('kc-' + key + '-' + P.slots[i].slot); break; }
        }
      }
      scrollToEl(target || document.getElementById('ceo-portfolios'));
      if (target) {
        target.classList.remove('flash');
        void target.offsetWidth;
        target.classList.add('flash');
      }
    }
  }

  function paintTabs() {
    var ps = S.frame.portfolios;
    for (var i = 0; i < ps.length; i++) {
      var t = UI.tabs[ps[i].key];
      t.setAttribute('aria-selected', String(ps[i].key === S.focus));
      t.firstChild.className = 'st st-' + portfolioStatus(ps[i]);
    }
  }

  function paintPortfolio() {
    var P = portfolioBy(S.focus);
    var b = UI.pbody;
    b.innerHTML = '';
    if (!P) return;
    var head = el('div', 'pb-h');
    var hl = el('div');
    hl.appendChild(el('div', 'pb-t', P.label));
    var sub = el('div', 'pb-s');
    sub.appendChild(el('span', '', P.slots.length + ' measures'));
    sub.appendChild(el('span', 'dot', '·'));
    sub.appendChild(el('span', '', 'on ' + (P.tables.length ? P.tables.join(', ') : 'no table')));
    hl.appendChild(sub);
    head.appendChild(hl);
    var acts = el('div', 'pb-a');
    var full = el('a', 'btn', 'Full portfolio analysis');
    full.appendChild(icon('arrow'));
    full.href = page('cmd_dashboard') + '?portfolio=' + encodeURIComponent(P.key);
    acts.appendChild(full);
    head.appendChild(acts);
    b.appendChild(head);

    if (P.duplicate) {
      b.appendChild(el('div', 'note', 'Every slot of ' + P.label + ' points at the same indicator in the ' +
        'source configuration, so these cards repeat one measure. That is how this portfolio is ' +
        'configured on the source dashboard, not a result of redrawing it.'));
    }
    if (P.slots.length < SLOT_ORDER.length) {
      b.appendChild(el('div', 'note', (SLOT_ORDER.length - P.slots.length) + ' of ' + P.label +
        '’s slots have no indicator configured on this instance.'));
    }

    var grid = el('div', 'kgrid');
    for (var i = 0; i < SLOT_ORDER.length; i++) {
      var id = slotId(P, SLOT_ORDER[i]);
      if (!id) continue;
      grid.appendChild(card(P, SLOT_ORDER[i], id));
    }
    b.appendChild(grid);

    UI.bd = el('div', 'bdwrap');
    b.appendChild(UI.bd);
    paintBreakdown();
  }

  function card(P, slot, id) {
    var r = res(id), meta = ind(id);
    var c = el('article', 'kc panel' + (r && !r.ok ? ' off' : ''));
    c.id = 'kc-' + P.key + '-' + slot;
    var top = el('div', 'kc-top');
    var eb = el('span', 'kc-e');
    eb.appendChild(icon(slotIcon(slot)));
    eb.appendChild(el('span', '', SLOT_NAME[slotFamily(slot)] + ' · ' + slot.replace(/\D/g, '')));
    top.appendChild(eb);
    var info = iconBtn('info', 'How this is computed', null, 'sm');
    info.addEventListener('click', function (e) { e.stopPropagation(); openInfo(info, id, P); });
    top.appendChild(info);
    c.appendChild(top);

    c.appendChild(el('h3', 'kc-n', meta.name));
    var vr = el('div', 'kc-v');
    if (!r) vr.appendChild(el('span', 'skel-line'));
    else {
      vr.appendChild(valueNode(r.value, r.unit, 'big'));
      vr.appendChild(deltaChip(r));
    }
    c.appendChild(vr);

    var sub = el('div', 'kc-s');
    if (r) {
      if (!r.ok || r.value === null) {
        sub.textContent = r.why || 'not measurable here';
        sub.className = 'kc-s why';
      } else if (r.kind === 'event') {
        var pa = el('span', 'pa');
        pa.appendChild(el('span', 'pa-k', 'Today, PA definition'));
        pa.appendChild(el('span', 'pa-v', r.pa === null ? (r.whyPa ? 'not computable' : '—') : fmtVal(r.pa, r.unit)));
        sub.appendChild(pa);
        if (r.delta) sub.appendChild(el('span', 'kc-pp', prevPhrase(r)));
      } else {
        sub.appendChild(el('span', 'now', 'Now'));
        sub.appendChild(el('span', 'kc-pp', r.delta ? prevPhrase(r) : 'a point in time, so the period does not apply'));
      }
    }
    c.appendChild(sub);

    var tr = trendOf(r);
    if (tr) {
      var sp = el('div', 'kc-sp');
      sp.appendChild(K.sparkline(tr.counts, tr.periods));
      sp.title = tr.label;
      c.appendChild(sp);
      c.appendChild(el('div', 'kc-sl', tr.label));
    }

    if (r && (r.mode === 'FILTERED' || r.mode === 'BOUNDED' || r.bounded)) {
      var m = el('div', 'kc-m');
      m.appendChild(K.aclChip({ mode: r.bounded ? 'BOUNDED' : r.mode, delta: (S.tables[r.table] || {}).delta || 0 }));
      c.appendChild(m);
    }
    if (r && r.filter && r.filter !== 'n/a' && r.filter !== 'all') {
      c.appendChild(el('div', 'kc-f', r.filter === 'none' ? 'Filters do not apply to this measure'
                                                          : 'Filters apply to part of this measure'));
    }

    var acts = el('div', 'kc-a');
    if (r && r.ok) {
      var an = el('a', 'lnk', 'Analyse');
      an.appendChild(icon('arrow'));
      an.href = analysisUrl(P.key, id);
      an.title = 'Open this measure as a full analysis, over ' + periodObj(S.period).label.toLowerCase();
      acts.appendChild(an);
      if (r.records) {
        var rec = el('a', 'lnk q', 'Records');
        rec.appendChild(icon('ext'));
        rec.href = r.records;
        rec.title = 'The platform list behind this number, with your own row-level access enforced';
        acts.appendChild(rec);
      }
    }
    c.appendChild(acts);
    return c;
  }

  function paintBreakdown() {
    if (!UI.bd) return;
    var box = UI.bd;
    box.innerHTML = '';
    var P = portfolioBy(S.focus);
    if (!P) return;
    var st = S.breakdown[S.focus];
    if (!P.breakdown || (st && st.none)) return;
    if (!st || st.loading) {
      var sk = el('div', 'panel cp');
      sk.appendChild(el('div', 'skel-block skel-title'));
      sk.appendChild(el('div', 'skel-block skel-panel'));
      box.appendChild(sk);
      return;
    }
    if (st.error || !st.panel) {
      box.appendChild(el('div', 'note', st.error || ('Breakdown: ' + (st.why || 'nothing to draw.'))));
      return;
    }
    var pl = { path: [], subject: { table: st.measure.table, listUrl: st.records }, window: { months: 12 }, forms: {},
                   drill: { atMax: true, options: [] } };
    var node = K.buildPanel(st.panel, pl);
    node.classList.add('bd');
    var foot = el('div', 'cp-f');
    foot.appendChild(el('span', '', 'Click a bar to analyse ' + st.measure.name.toLowerCase() + ' for that value.'));
    if (st.records) {
      var a = el('a', 'lnk q', 'Records');
      a.appendChild(icon('ext'));
      a.href = st.records;
      foot.appendChild(a);
    }
    node.appendChild(foot);
    node.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== node && !(t.getAttribute && t.getAttribute('data-drill-field'))) t = t.parentNode;
      if (!t || t === node) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.href = analysisUrl(P.key, st.measure.id,
        { field: t.getAttribute('data-drill-field'), key: t.getAttribute('data-drill-key') });
    }, true);
    box.appendChild(node);
  }

  /* ── the "how is this computed" popover ─────────────────────────────────── */

  function openInfo(anchor, id, P) {
    var r = res(id), meta = ind(id), pop = UI.pop;
    pop.innerHTML = '';
    var h = el('div', 'ip-h');
    h.appendChild(el('div', 'h3', meta.name));
    var x = iconBtn('close', 'Close', closeInfo, 'sm');
    h.appendChild(x);
    pop.appendChild(h);
    var d = r && r.definition ? r.definition : {};
    var rows = [];
    rows.push(['Source', 'Performance Analytics indicator, slot ' + P.label]);
    if (d.formula) rows.push(['Formula', d.formula]);
    if (d.table) rows.push(['Counts', (d.aggregate && d.aggregate !== 'COUNT' ? d.aggregate.toLowerCase().replace('_', ' ') + ' of ' + d.field + ' on ' : 'records on ') + d.table]);
    if (d.slice) rows.push(['Which records', d.slice]);
    if (d.elapsed) rows.push(['Elapsed time', 'hours from ' + d.elapsed.from.replace('*now*', 'now') + ' to ' + d.elapsed.to.replace('*now*', 'now')]);
    if (meta.kind === 'event') {
      rows.push(['Period', 'PA defines this for today on ' + (d.dateField || 'its date field') +
                 '. Here it is widened to ' + periodObj(S.period).label.toLowerCase() + '; the PA-definition value is shown on the card.']);
    } else if (meta.kind === 'stock') {
      rows.push(['Period', 'A point in time: how things stand now. The period does not apply.']);
    }
    rows.push(['Direction', meta.dir === 'down' ? 'Lower is better' : meta.dir === 'up' ? 'Higher is better' : 'No preferred direction, so changes are not judged']);
    if (r) {
      var tv = S.tables[r.table];
      rows.push(['Access', (r.mode || 'unknown') + (tv ? ' · ' + K.fmt(tv.secure) + ' of ' + K.fmt(tv.aggregate) + ' ' + tv.label.toLowerCase() + ' readable by you' : '')]);
      if (r.filter && r.filter !== 'n/a') rows.push(['Filters', r.filter === 'all' ? 'applied' : r.filter === 'some' ? 'applied to part of this measure' : 'not applicable to this table']);
      if (!r.ok || r.value === null) rows.push(['Why no value', r.why || '']);
    }
    var dl = el('dl', 'ip-dl');
    for (var i = 0; i < rows.length; i++) {
      dl.appendChild(el('dt', '', rows[i][0]));
      dl.appendChild(el('dd', '', rows[i][1]));
    }
    pop.appendChild(dl);
    pop.className = 'ipop on';
    var rc = anchor.getBoundingClientRect();
    var sx = window.pageXOffset || 0, sy = window.pageYOffset || 0;
    var w = Math.min(380, window.innerWidth - 24);
    pop.style.width = w + 'px';
    var left = Math.max(12 + sx, Math.min(rc.right + sx - w, sx + window.innerWidth - w - 12));
    pop.style.left = left + 'px';
    pop.style.top = (rc.bottom + sy + 8) + 'px';
    x.focus();
  }

  function closeInfo() { if (UI.pop) UI.pop.className = 'ipop'; }

  /* ── trends ─────────────────────────────────────────────────────────────── */

  function trendsSection() {
    var s = section('ceo-trends', 'Trends', 'The flow of work, over twelve months',
      'Drawn from the same measures as the cards: arrivals against completions, and the backlog they leave behind.');
    UI.trends = el('div', 'grid-panels');
    s.appendChild(UI.trends);
    return s;
  }

  function findIndicator(name) {
    var inds = S.frame.indicators;
    for (var id in inds) if (inds.hasOwnProperty(id) && inds[id].name === name) return id;
    return null;
  }

  function periodsFrom(labels) {
    var out = [];
    for (var i = 0; i < labels.length; i++) out.push({ period: labels[i], label: labels[i], partial: i === labels.length - 1 });
    return out;
  }

  function paintTrends() {
    var box = UI.trends;
    box.innerHTML = '';
    if (!S.meta || !S.meta.monthLabels) {
      for (var sk = 0; sk < 2; sk++) {
        var ph = el('div', 'panel cp' + (sk === 0 ? ' span2' : ''));
        ph.appendChild(el('div', 'skel-block skel-title'));
        ph.appendChild(el('div', 'skel-block skel-panel'));
        box.appendChild(ph);
      }
      return;
    }
    var periods = periodsFrom(S.meta.monthLabels);
    var pl = { path: [], subject: { table: 'incident' }, window: { months: 12 }, forms: {},
               drill: { atMax: true, options: [] } };
    var flows = [['Number of new incidents', 'Opened'], ['Number of resolved incidents', 'Resolved'],
                 ['Number of closed incidents', 'Closed']];
    var series = [];
    for (var i = 0; i < flows.length; i++) {
      var r = res(findIndicator(flows[i][0]));
      if (r && r.months) series.push({ key: flows[i][1], label: flows[i][1], counts: r.months });
    }
    if (series.length) {
      box.appendChild(K.buildPanel({
        id: 'ceo_flow', kind: 'series', form: 'line_multi', span: 2,
        question: 'Incidents opened, resolved and closed, by month',
        reason: 'Arrivals against completions. Where opened runs above resolved, the backlog grows.' +
                (S.filters.length ? ' Filters applied where the table has the field.' : ''),
        periods: periods, series: series
      }, pl));
    }
    var open = res(findIndicator('Number of open incidents'));
    if (open && open.months) {
      var pts = [];
      for (var j = 0; j < open.months.length; j++) {
        pts.push({ period: periods[j].period, label: periods[j].label, count: open.months[j] || 0,
                   partial: j === open.months.length - 1 });
      }
      box.appendChild(K.buildPanel({
        id: 'ceo_backlog', kind: 'series', form: 'area', span: 1,
        question: 'Open incidents at each month end',
        reason: 'The backlog as it stood when each month closed; the last point is now.',
        points: pts
      }, pl));
    }
    var em = res(findIndicator('Benchmark: % of emergency changes'));
    if (em && em.months) {
      var pts2 = [];
      for (var k = 0; k < em.months.length; k++) {
        pts2.push({ period: periods[k].period, label: periods[k].label, count: em.months[k] || 0,
                    partial: k === em.months.length - 1 });
      }
      box.appendChild(K.buildPanel({
        id: 'ceo_emergency', kind: 'series', form: 'line', span: 1,
        question: 'Emergency changes, as a share of changes closed',
        reason: 'Monthly, from the same formula as the Portfolio 8 card. A rising share is change risk.',
        points: pts2
      }, pl));
    }
    if (!box.firstChild) box.appendChild(el('div', 'note', 'No twelve-month history is available for these measures.'));
  }

  /* ── trust ──────────────────────────────────────────────────────────────── */

  function trustSection() {
    var s = section('ceo-trust', 'Trust', 'How these numbers were counted, for you',
      'Performance Analytics stores scores computed once, for everyone, with row-level security bypassed. Every number here is counted at the moment you open the page, against what you personally may read.');
    UI.trust = el('div', 'trust');
    s.appendChild(UI.trust);
    return s;
  }

  function paintTrust() {
    var box = UI.trust;
    box.innerHTML = '';
    var tl = el('div', 'panel pad tv');
    tl.appendChild(el('div', 'h3', 'Access, table by table'));
    var any = false;
    for (var t in S.tables) {
      if (!S.tables.hasOwnProperty(t)) continue;
      any = true;
      var v = S.tables[t];
      var row = el('div', 'tv-r');
      row.appendChild(el('span', 'tv-t', v.label || t));
      row.appendChild(K.aclChip({ mode: v.mode, delta: v.delta }));
      row.appendChild(el('span', 'tv-n', v.mode === 'DENIED' ? 'none readable'
        : K.fmt(v.secure) + ' of ' + K.fmt(v.aggregate) + ' readable'));
      tl.appendChild(row);
    }
    if (!any) tl.appendChild(el('div', 'skel-block skel-sub'));
    box.appendChild(tl);

    var notes = el('div', 'tn');
    notes.appendChild(trustNote('Your access, not an administrator’s',
      'A native report or PA score counts every record on the table. Here each table is proved against your permissions first; where you cannot read every row, the numbers are computed from the rows you can, and say so.'));
    notes.appendChild(trustNote('PA’s definition is always on the card',
      'Most source indicators are defined for today only, which is why the source dashboard is mostly blank on a quiet day. Cards show the period you choose, with PA’s own today figure beside it, so the number that matches the source is never hidden.'));
    notes.appendChild(trustNote('Real history, not decoration',
      'Every trend line is counted from the records themselves. The source dashboard’s sparklines have no score history behind them.'));
    var cfg = [];
    var ps = S.frame.portfolios;
    for (var i = 0; i < ps.length; i++) if (ps[i].duplicate) cfg.push(ps[i].label);
    if (cfg.length) {
      notes.appendChild(trustNote('Configuration, reported rather than hidden',
        cfg.join(', ') + ' repeat a single indicator in every slot in the source configuration (' +
        S.frame.source + '). They are drawn faithfully and marked.'));
    }
    box.appendChild(notes);
  }

  function trustNote(t, b) {
    var d = el('div', 'panel pad tnote');
    d.appendChild(el('div', 'h3', t));
    d.appendChild(el('p', 'sm', b));
    return d;
  }

  function footer() {
    var f = el('footer', 'ceo-foot');
    UI.foot = el('span', '', '');
    f.appendChild(UI.foot);
    var a = el('a', 'lnk', 'All dashboards and reports');
    a.appendChild(icon('arrow'));
    a.href = page('cmd_catalog');
    f.appendChild(a);
    return f;
  }

  /* ── the filter drawer: the "hidden slicer panel" ───────────────────────── */

  function drawer() {
    var wrap = el('div', 'drawer');
    wrap.setAttribute('aria-hidden', 'true');
    var shade = el('div', 'dr-shade');
    shade.addEventListener('click', closeDrawer);
    wrap.appendChild(shade);
    var p = el('aside', 'dr-p');
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Filters');
    var h = el('div', 'dr-h');
    var ht = el('div');
    ht.appendChild(el('div', 'h3', 'Filters'));
    ht.appendChild(el('div', 'sm', 'Applied to every measure whose table has the field. Measures on other tables are left as they are, and marked.'));
    h.appendChild(ht);
    h.appendChild(iconBtn('close', 'Close filters', closeDrawer, 'sm'));
    p.appendChild(h);
    UI.drBody = el('div', 'dr-b');
    p.appendChild(UI.drBody);
    var foot = el('div', 'dr-f');
    var clear = el('button', 'btn ghost', 'Clear all');
    clear.type = 'button';
    clear.addEventListener('click', function () { UI.draft = []; paintDrawer(); });
    var apply = el('button', 'btn primary', 'Apply');
    apply.type = 'button';
    apply.addEventListener('click', function () {
      S.filters = normalise(UI.draft);
      closeDrawer();
      syncUrl();
      paintChips();
      S.breakdown = {};
      load(false);
    });
    foot.appendChild(clear);
    foot.appendChild(apply);
    p.appendChild(foot);
    wrap.appendChild(p);
    UI.drawer = wrap;
    return wrap;
  }

  function normalise(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i].values.length) out.push({ field: list[i].field, values: list[i].values.slice() });
    out.sort(function (a, b) { return a.field < b.field ? -1 : 1; });
    return out;
  }

  function draftFor(field) {
    for (var i = 0; i < UI.draft.length; i++) if (UI.draft[i].field === field) return UI.draft[i];
    var d = { field: field, values: [] };
    UI.draft.push(d);
    return d;
  }

  function openDrawer() {
    UI.draft = JSON.parse(JSON.stringify(S.filters));
    paintDrawer();
    UI.drawer.classList.add('open');
    UI.drawer.setAttribute('aria-hidden', 'false');
    var first = UI.drawer.querySelector('button.opt, .dr-h button');
    if (first) first.focus();
  }

  function closeDrawer() {
    UI.drawer.classList.remove('open');
    UI.drawer.setAttribute('aria-hidden', 'true');
    if (UI.filterBtn) UI.filterBtn.focus();
  }

  function paintDrawer() {
    var b = UI.drBody;
    b.innerHTML = '';
    var fs = S.frame.filters || [];
    if (!fs.length) b.appendChild(el('p', 'sm', 'No filters are available on this instance.'));
    for (var i = 0; i < fs.length; i++) {
      (function (F) {
        var g = el('div', 'dr-g');
        g.appendChild(el('div', 'dr-gl', F.label));
        var opts = el('div', 'opts');
        var d = draftFor(F.field);
        for (var j = 0; j < F.options.length; j++) {
          (function (o) {
            var on = d.values.indexOf(o.value) !== -1;
            var bt = el('button', 'opt' + (on ? ' on' : ''), o.label);
            bt.type = 'button';
            bt.setAttribute('aria-pressed', String(on));
            bt.addEventListener('click', function () {
              var k = d.values.indexOf(o.value);
              if (k === -1) d.values.push(o.value); else d.values.splice(k, 1);
              bt.classList.toggle('on', k === -1);
              bt.setAttribute('aria-pressed', String(k === -1));
            });
            opts.appendChild(bt);
          })(F.options[j]);
        }
        g.appendChild(opts);
        b.appendChild(g);
      })(fs[i]);
    }
  }

  function optionLabel(field, value) {
    var fs = S.frame.filters || [];
    for (var i = 0; i < fs.length; i++) {
      if (fs[i].field !== field) continue;
      for (var j = 0; j < fs[i].options.length; j++) if (fs[i].options[j].value === value) return fs[i].options[j].label;
      return value;
    }
    return value;
  }

  function fieldLabel(field) {
    var fs = S.frame.filters || [];
    for (var i = 0; i < fs.length; i++) if (fs[i].field === field) return fs[i].label;
    return field;
  }

  function paintChips() {
    var box = UI.chips;
    box.innerHTML = '';
    var n = 0;
    for (var i = 0; i < S.filters.length; i++) n += S.filters[i].values.length;
    UI.filterCount.textContent = n ? String(n) : '';
    UI.filterBtn.classList.toggle('on', !!n);
    if (!S.filters.length) { box.classList.remove('on'); return; }
    box.classList.add('on');
    box.appendChild(el('span', 'fl', 'Filtered'));
    for (var k = 0; k < S.filters.length; k++) {
      (function (F) {
        var labels = [];
        for (var j = 0; j < F.values.length; j++) labels.push(optionLabel(F.field, F.values[j]));
        var c = el('span', 'fchip');
        c.appendChild(el('span', '', fieldLabel(F.field) + ': ' + labels.join(', ')));
        var x = el('button', 'x');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove the ' + fieldLabel(F.field) + ' filter');
        x.appendChild(icon('close'));
        x.addEventListener('click', function () {
          var next = [];
          for (var q = 0; q < S.filters.length; q++) if (S.filters[q].field !== F.field) next.push(S.filters[q]);
          S.filters = next;
          syncUrl();
          paintChips();
          S.breakdown = {};
          load(false);
        });
        c.appendChild(x);
        box.appendChild(c);
      })(S.filters[k]);
    }
    UI.applies = el('span', 'fapp', '');
    box.appendChild(UI.applies);
  }

  function paintApplies() {
    if (!UI.applies || !S.filters.length) return;
    var all = 0, some = 0, none = 0, seen = {};
    for (var id in S.results) {
      if (!S.results.hasOwnProperty(id) || seen[id]) continue;
      seen[id] = true;
      var f = S.results[id].filter;
      if (f === 'all') all++; else if (f === 'some') some++; else if (f === 'none') none++;
    }
    UI.applies.textContent = 'Applied to ' + all + ' measure' + (all === 1 ? '' : 's') +
      (some ? ', partly to ' + some : '') + (none ? '; ' + none + ' on tables without these fields are unfiltered' : '');
  }

  /* ── share, export, present ─────────────────────────────────────────────── */

  function toast(msg) {
    UI.toast.textContent = msg;
    UI.toast.className = 'toast on';
    clearTimeout(UI.toastT);
    UI.toastT = setTimeout(function () { UI.toast.className = 'toast'; }, 2600);
  }

  function share() {
    var url = window.location.origin + '/' + stateUrl();
    var done = function () { toast('Link copied: this period, these filters, this portfolio.'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url); done(); });
        return;
      }
    } catch (e) { /* fall through */ }
    fallbackCopy(url);
    done();
  }

  function fallbackCopy(text) {
    var ta = el('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    document.body.removeChild(ta);
  }

  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv() {
    var P = periodObj(S.period);
    var lines = [['CEO Dashboard'], ['Period', P.label], ['Filters', filterStr() || 'none'],
                 ['Exported', new Date().toISOString()], ['Viewer', S.frame.viewer.name], [],
                 ['Portfolio', 'Slot', 'Measure', 'Value', 'Unit', 'Kind', 'Today (PA definition)',
                  'Previous', 'Change', 'Better?', 'Access', 'Filter', 'Note']];
    var ps = S.frame.portfolios;
    for (var i = 0; i < ps.length; i++) {
      for (var j = 0; j < ps[i].slots.length; j++) {
        var sl = ps[i].slots[j], r = res(sl.id) || {};
        lines.push([ps[i].label, sl.slot, ind(sl.id).name, r.value, ind(sl.id).unit, r.kind, r.pa,
                    r.delta ? r.delta.prev : '', r.delta ? r.delta.abs : '',
                    r.delta ? (r.delta.better === null ? '' : r.delta.better ? 'yes' : 'no') : '',
                    r.mode, r.filter, r.why || '']);
      }
    }
    var text = [];
    for (var k = 0; k < lines.length; k++) {
      var cells = [];
      for (var c = 0; c < lines[k].length; c++) cells.push(csvCell(lines[k][c]));
      text.push(cells.join(','));
    }
    var blob = new Blob(['﻿' + text.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ceo-dashboard-' + S.period + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
  }

  var CYCLE_MS = 14000, PRESENT_REFRESH_MS = 300000;

  function togglePresent() {
    var w = document.getElementById('cmd-wrap');
    S.presenting = !S.presenting;
    w.classList.toggle('presenting', S.presenting);
    if (S.presenting) {
      try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch (e) { /* optional */ }
      var steps = ['ceo-overview', 'ceo-pulse'], ps = S.frame.portfolios, i;
      for (i = 0; i < ps.length; i++) steps.push('p:' + ps[i].key);
      steps.push('ceo-trends');
      var at = 0;
      var step = function () {
        var s = steps[at % steps.length];
        at++;
        if (s.indexOf('p:') === 0) { focusPortfolio(s.substring(2), true); }
        else { var t = document.getElementById(s); if (t) scrollToEl(t); }
      };
      step();
      S.presentTimer = setInterval(step, CYCLE_MS);
      S.refreshTimer = setInterval(function () { load(true); }, PRESENT_REFRESH_MS);
      toast('Presenting. Press Esc to stop.');
    } else {
      clearInterval(S.presentTimer);
      clearInterval(S.refreshTimer);
      try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e2) { /* optional */ }
    }
  }

  /* ── keyboard, scroll spy ───────────────────────────────────────────────── */

  function wireKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (S.presenting) togglePresent();
        if (UI.drawer && UI.drawer.classList.contains('open')) closeDrawer();
        closeInfo();
        closeMenus();
        return;
      }
      var t = e.target;
      if (t && t.classList && t.classList.contains('sat') &&
          (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        var ps = S.frame.portfolios, key = t.getAttribute('data-key'), i;
        for (i = 0; i < ps.length; i++) if (ps[i].key === key) break;
        var step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
        var next = ps[(i + step + ps.length) % ps.length];
        UI.orbs[next.key].node.focus();
        e.preventDefault();
      }
    });
    document.addEventListener('click', function (e) {
      closeMenus();
      if (UI.pop && UI.pop.className.indexOf('on') !== -1 && !UI.pop.contains(e.target)) closeInfo();
    });
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement && S.presenting) togglePresent();
    });
  }

  function wireScrollSpy() {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        var id = entries[i].target.id;
        for (var k in UI.navLinks) {
          if (UI.navLinks.hasOwnProperty(k)) UI.navLinks[k].setAttribute('aria-current', String(k === id));
        }
      }
    }, { rootMargin: '-40% 0px -55% 0px' });
    var secs = document.querySelectorAll('#cmd-wrap section.sec');
    for (var j = 0; j < secs.length; j++) io.observe(secs[j]);
  }

  /* ── painting everything that depends on data ──────────────────────────── */

  function paintValues() {
    paintPeriod();
    paintHero();
    paintOrbit();
    paintMoves();
    paintPulse();
    paintTabs();
    paintPortfolio();
    paintTrends();
    paintTrust();
    paintApplies();
    paintStatus();
  }

  function paintStatus() {
    var st = UI.status;
    st.innerHTML = '';
    if (S.errors.length) {
      var e = el('div', 'note warn');
      e.appendChild(el('span', '', S.errors[0] + ' '));
      var retry = el('button', 'btn sm', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', function () { load(true); });
      e.appendChild(retry);
      st.appendChild(e);
    }
    var m = S.meta;
    if (UI.asof) {
      UI.asof.textContent = S.loading > 0 ? 'Counting…'
        : m ? 'As of ' + String(m.generated || '').substring(11, 16) + (m.cached ? ' · remembered' : '') : '';
      UI.asof.title = m ? 'Computed ' + (m.generated || '') + ' in ' + m.computeMs + 'ms' +
        (m.cached ? ', remembered from ' + Math.round(m.ageMs / 1000) + 's ago. Refresh recounts.' : '') : '';
    }
    if (UI.foot) {
      UI.foot.textContent = 'Signed in as ' + S.frame.viewer.display + ' · ' +
        (m ? 'counted ' + (m.generated || '') + ' · ' : '') + 'source: ' + S.frame.source;
    }
  }

  /* ── boot ───────────────────────────────────────────────────────────────── */

  function boot() {
    var mount = document.getElementById('cmd-root');
    var holder = document.getElementById('cmd-data');
    if (!mount || !holder || holder.getAttribute('data-view') !== 'ceo') return;
    var frame;
    try { frame = K.decode(); } catch (e) {
      mount.appendChild(el('div', 'note', 'The page data could not be read: ' + (e && e.message ? e.message : e)));
      return;
    }
    if (!frame) return;
    S.frame = frame;
    S.prefix = frame.scope ? frame.scope + '_' : '';
    S.ajax = (frame.scope ? frame.scope + '.' : '') + 'CmdCeoAjax';
    if (frame.request) {
      S.period = frame.request.period || frame.period || '30d';
      S.filters = frame.request.filters || [];
      S.focus = frame.request.focus || '';
    }
    if (frame.portfolios && !portfolioBy(S.focus)) S.focus = frame.portfolios.length ? frame.portfolios[0].key : '';

    try {
      render(mount);
    } catch (err) {
      mount.innerHTML = '';
      var box = el('div', 'panel pad');
      box.appendChild(el('div', 'h3', 'The page failed to render'));
      box.appendChild(el('p', 'sm', String(err && err.message ? err.message : err)));
      mount.appendChild(box);
      if (window.console) window.console.error(err);
      return;
    }
    marks.painted = Math.round(performance.now());
    if (frame.error || frame.denied) { window.__cmdCeoReady = true; return; }

    var warm = frame.warm || {}, nWarm = 0;
    for (var g in warm) if (warm.hasOwnProperty(g)) { absorb(warm[g]); nWarm++; }
    if (nWarm && nWarm === (frame.groups || []).length) {
      marks.firstData = marks.allData = marks.painted;
      marks.warm = true;
      paintValues();
      window.__cmdCeoReady = true;
      loadBreakdown(S.focus, false);
    } else {
      load(false);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
