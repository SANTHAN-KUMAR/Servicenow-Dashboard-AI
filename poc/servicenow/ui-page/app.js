/* EY AI Analytics Dashboard — Use Case 2 POC
 * Runs entirely inside ServiceNow. ECharts is served from an instance attachment,
 * data from the ey_ai_dashboard Scripted REST API, AI insight from Now Assist.
 */
(function () {
  'use strict';

  var API = '/api/eyi/ey_ai_dashboard';
  var charts = [];
  var STATE = { data: null };

  // Palette roles resolved from CSS so light/dark swap in one place.
  function css(name, fallback) {
    var v = getComputedStyle(document.querySelector('.eyd')).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  function P() {
    return {
      s1: css('--s1', '#2a78d6'),
      s2: css('--s2', '#eb6834'),
      s3: css('--s3', '#1baf7a'),
      ink1: css('--ink-1', '#0b0b0b'),
      ink2: css('--ink-2', '#52514e'),
      ink3: css('--ink-3', '#898781'),
      grid: css('--grid', '#e1e0d9'),
      axis: css('--axis', '#c3c2b7'),
      surface: css('--surface-1', '#fcfcfb')
    };
  }
  // Ordinal blue ramp, validated light + dark (monotone L, gaps >= .06).
  function ordinal5() {
    var dark = isDark();
    return dark
      ? ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf']
      : ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef'];
  }
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    n = Number(n);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n * 10) / 10);
  }
  function full(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return Number(n).toLocaleString();
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function el(id) { return document.getElementById(id); }

  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function monthLabel(ym) {
    var p = String(ym).split('-');
    if (p.length < 2) return ym;
    return MON[parseInt(p[1], 10) - 1] + " '" + p[0].substring(2);
  }
  function pct(part, whole) {
    if (!whole) return '0%';
    var v = (part / whole) * 100;
    return (v >= 99.95 ? v.toFixed(0) : v.toFixed(1)) + '%';
  }

  // ---------------------------------------------------------------- charting

  function baseGrid(extra) {
    var p = P();
    var g = {
      backgroundColor: 'transparent',
      animationDuration: 520,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
      tooltip: {
        trigger: 'item',
        backgroundColor: p.surface,
        borderColor: p.grid,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: p.ink1, fontSize: 12.5 },
        extraCssText: 'box-shadow:0 4px 18px rgba(0,0,0,.14);border-radius:10px;'
      }
    };
    for (var k in (extra || {})) g[k] = extra[k];
    return g;
  }

  function mount(id, option) {
    var node = el(id);
    if (!node) return null;
    var c = echarts.init(node, null, { renderer: 'canvas' });
    c.setOption(option);
    charts.push(c);
    return c;
  }

  /* Monthly volume — one series, so no legend; the title names it. */
  function chartMonthly(series) {
    var p = P();
    var months = series.map(function (r) { return r.period; });
    var vals = series.map(function (r) { return r.count; });
    mount('ch-monthly', baseGrid({
      grid: { left: 8, right: 30, top: 18, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: p.axis, width: 1, type: 'dashed' } },
        backgroundColor: p.surface, borderColor: p.grid, borderWidth: 1,
        textStyle: { color: p.ink1, fontSize: 12.5 },
        extraCssText: 'box-shadow:0 4px 18px rgba(0,0,0,.14);border-radius:10px;',
        formatter: function (ps) {
          var d = ps[0];
          return '<b>' + d.axisValue + '</b><br/>' + full(d.data) + ' opened';
        }
      },
      xAxis: {
        type: 'category', data: months, boundaryGap: false,
        axisLine: { lineStyle: { color: p.axis } },
        axisTick: { show: false },
        axisLabel: { color: p.ink3, fontSize: 11, formatter: monthLabel }
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: p.grid, width: 1 } },
        axisLabel: { color: p.ink3, fontSize: 11, formatter: function (v) { return fmt(v); } }
      },
      series: [{
        type: 'line', data: vals, smooth: 0.32, symbol: 'circle', symbolSize: 8,
        lineStyle: { width: 2, color: p.s1 },
        itemStyle: { color: p.s1, borderColor: p.surface, borderWidth: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexA(p.s1, 0.26) },
            { offset: 1, color: hexA(p.s1, 0.01) }
          ])
        }
      }]
    }));
  }

  function hexA(hex, a) {
    hex = (hex || '').trim().replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var r = parseInt(hex.substring(0, 2), 16), g = parseInt(hex.substring(2, 4), 16), b = parseInt(hex.substring(4, 6), 16);
    if (isNaN(r)) return 'rgba(42,120,214,' + a + ')';
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* Horizontal bar, single hue. Direct value labels satisfy the relief rule. */
  function chartBar(id, rows, color, unit, maxN) {
    var p = P();
    var top = rows.slice(0, maxN || 8).slice().reverse();
    mount(id, baseGrid({
      grid: { left: 8, right: 54, top: 10, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'item',
        backgroundColor: p.surface, borderColor: p.grid, borderWidth: 1,
        textStyle: { color: p.ink1, fontSize: 12.5 },
        extraCssText: 'box-shadow:0 4px 18px rgba(0,0,0,.14);border-radius:10px;',
        formatter: function (d) { return '<b>' + esc(d.name) + '</b><br/>' + full(d.value) + (unit || ''); }
      },
      xAxis: { type: 'value', show: false },
      yAxis: {
        type: 'category',
        data: top.map(function (r) { return r.label; }),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: {
          color: p.ink2, fontSize: 12,
          formatter: function (v) { return v.length > 22 ? v.substring(0, 21) + '…' : v; }
        }
      },
      series: [{
        type: 'bar',
        data: top.map(function (r) { return r.count !== undefined ? r.count : r.hours; }),
        barWidth: '58%',
        itemStyle: { color: color, borderRadius: [0, 4, 4, 0] },
        label: {
          show: true, position: 'right', color: p.ink2, fontSize: 11.5, fontWeight: 600,
          formatter: function (d) { return fmt(d.value) + (unit || ''); }
        }
      }]
    }));
  }

  /* Priority — ordinal severity, so a single-hue ordered ramp, not categorical hues. */
  function chartDonut(id, rows, colors) {
    var p = P();
    mount(id, baseGrid({
      legend: {
        orient: 'vertical', right: 4, top: 'center', itemWidth: 10, itemHeight: 10,
        icon: 'roundRect', textStyle: { color: p.ink2, fontSize: 12 }
      },
      series: [{
        type: 'pie', radius: ['58%', '82%'], center: ['33%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 6 },
        data: rows.map(function (r, i) {
          return { name: r.label, value: r.count, itemStyle: { color: colors[i % colors.length] } };
        })
      }],
      tooltip: {
        trigger: 'item',
        backgroundColor: p.surface, borderColor: p.grid, borderWidth: 1,
        textStyle: { color: p.ink1, fontSize: 12.5 },
        extraCssText: 'box-shadow:0 4px 18px rgba(0,0,0,.14);border-radius:10px;',
        formatter: function (d) {
          return '<b>' + esc(d.name) + '</b><br/>' + full(d.value) + '  (' + d.percent + '%)';
        }
      }
    }));
  }

  // ------------------------------------------------------------------ render

  function kpi(label, value, foot, accent) {
    return '<div class="eyd-kpi" style="--accent:' + accent + '">' +
      '<div class="eyd-kpi-label">' + esc(label) + '</div>' +
      '<div class="eyd-kpi-value">' + value + '</div>' +
      '<div class="eyd-kpi-foot">' + foot + '</div></div>';
  }

  function renderKpis(d) {
    var k = d.kpis, p = P();
    var hidden = Number(k.acl_hidden_from_viewer) || 0;
    var aclFoot = hidden > 0
      ? '<span class="bad">' + full(hidden) + ' hidden by ACL</span>'
      : '<span class="ok">matches ACL-filtered count</span>';
    var mttrDays = k.mttr_hours ? (k.mttr_hours / 24) : 0;

    el('kpis').innerHTML =
      kpi('Records visible to you', full(k.total_visible_to_viewer), aclFoot, p.s1) +
      kpi('Active', full(k.active),
          pct(k.active, k.total) + ' of all records', p.s1) +
      kpi('Priority 1 — Critical', full(k.p1),
          pct(k.p1, k.total) + ' of volume', 'var(--crit)') +
      kpi('Unassigned & active', full(k.unassigned_active),
          pct(k.unassigned_active, k.active) + ' of active work has no owner', 'var(--warn)') +
      kpi('Mean time to resolve', fmt(mttrDays) + ' <span style="font-size:15px;font-weight:600">days</span>',
          'only ' + full(k.mttr_sample) + ' of ' + full(k.total) + ' records are resolved', p.s2);
  }

  function renderTable(rows, valueHeader) {
    var h = '<div class="eyd-table-wrap"><table class="eyd-table"><thead><tr>' +
      '<th>Category</th><th class="num">' + esc(valueHeader) + '</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var v = r.count !== undefined ? r.count : r.hours;
      h += '<tr><td>' + esc(r.label) + '</td><td class="num">' + full(v) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function render(d) {
    STATE.data = d;
    el('viewer').innerHTML = esc(d.viewer_display) + ' &middot; ' + esc(d.table) +
      ' &middot; generated ' + esc(d.generated_at);
    renderKpis(d);

    charts.forEach(function (c) { try { c.dispose(); } catch (e) {} });
    charts = [];

    chartMonthly(d.monthly);
    chartBar('ch-category', d.by_category.rows, P().s1, '', 8);

    // Priority is ordinal severity, so order by the priority value (1..5) and let the
    // darkest ramp step carry P1 -- ranking by count would repaint severity by volume.
    var prio = d.by_priority.rows.slice().sort(function (a, b) {
      return (parseInt(a.key, 10) || 99) - (parseInt(b.key, 10) || 99);
    });
    chartDonut('ch-priority', prio, ordinal5());
    chartBar('ch-group', d.by_group.rows, P().s3, '', 8);
    chartBar('ch-mttr', d.mttr_by_category.map(function (r) {
      return { label: r.label, count: Math.round(r.hours / 24 * 10) / 10 };
    }), P().s2, 'd', 8);
    chartBar('ch-state', d.by_state.rows, P().s1, '', 7);

    // Table view (accessibility: identity never carried by colour alone).
    el('tbl-category').innerHTML = renderTable(d.by_category.rows, 'Records');

    // Data-shape read-out — this is what the chart-fitting layer keys off.
    el('shape').innerHTML =
      'category: ' + d.by_category.distinct + ' distinct, top share ' +
      Math.round(d.by_category.top_share * 100) + '%, concentration ' +
      Math.round(d.by_category.concentration * 100) + '% &nbsp;|&nbsp; ' +
      'assignment group: ' + d.by_group.distinct + ' distinct, concentration ' +
      Math.round(d.by_group.concentration * 100) + '%';
  }

  // -------------------------------------------------------------- ACL proof

  function loadAcl() {
    var box = el('acl');
    box.innerHTML = '<div class="eyd-acl-v">Running both aggregation paths as you…</div>';
    fetch(API + '/aclproof?table=incident&field=priority', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = j.result;
        var leaked = Number(d.leaked) || 0;
        box.innerHTML =
          '<div><div class="eyd-acl-lbl">GlideAggregate</div><div class="eyd-acl-num">' + full(d.aggregate_total) + '</div></div>' +
          '<div><div class="eyd-acl-lbl">ACL-filtered</div><div class="eyd-acl-num">' + full(d.secure_total) + '</div></div>' +
          '<div><div class="eyd-acl-lbl">Delta</div><div class="eyd-acl-num" style="color:' +
            (leaked > 0 ? 'var(--crit)' : 'var(--good-text)') + '">' + full(leaked) + '</div></div>' +
          '<span class="eyd-pill ' + (leaked > 0 ? 'eyd-pill-leak' : 'eyd-pill-safe') + '">' +
            (leaked > 0 ? 'Leak detected' : 'Verified safe') + '</span>' +
          '<div class="eyd-acl-v">' + esc(d.verdict) + '</div>';
      })
      .catch(function (e) {
        box.innerHTML = '<div class="eyd-acl-v">ACL check failed: ' + esc(e.message) + '</div>';
      });
  }

  // ------------------------------------------------------------------- AI

  function runAI() {
    var btn = el('btn-ai');
    var out = el('ai-body');
    if (!STATE.data) return;
    btn.disabled = true;
    btn.textContent = 'Analysing…';
    out.innerHTML = '<p class="eyd-empty">Sending the aggregates to the model…</p>';

    var d = STATE.data;
    // Send only the aggregates -- never raw records. Small payload, no PII.
    var payload = {
      context: 'ServiceNow ' + d.table + ' table, EY POC instance. Counts already ' +
               'filtered to what this viewer is permitted to read.',
      aggregates: {
        totals: d.kpis,
        by_category: d.by_category.rows.slice(0, 10),
        by_priority: d.by_priority.rows,
        by_state: d.by_state.rows,
        by_assignment_group: d.by_group.rows.slice(0, 10),
        monthly_opened: d.monthly,
        mean_resolution_hours_by_category: d.mttr_by_category.slice(0, 8)
      }
    };

    fetch(API + '/insights', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var res = j.result || j;
        if (!res.ok) {
          out.innerHTML = '<p class="eyd-empty"><b>AI call did not complete.</b><br/>' +
            esc(res.error || 'unknown error') +
            '<br/><span style="opacity:.75">Provider: ' +
            esc((res.ai_status && res.ai_status.effective_provider) || res.provider || '?') +
            '. The dashboard above is unaffected — it is computed on-instance.</span></p>';
          el('ai-provider').textContent = 'error';
          return;
        }
        el('ai-provider').textContent = res.provider + (res.model ? ' · ' + res.model : '');
        el('ai-provider').className = 'eyd-badge eyd-badge-live';
        var h = '<p class="eyd-headline">' + esc(res.headline || '') + '</p><div class="eyd-ins">';
        (res.insights || []).forEach(function (i) {
          var sev = (i.severity || 'info').toLowerCase();
          h += '<div class="eyd-ins-item eyd-sev-' + esc(sev) + '">' +
               '<p class="eyd-ins-t">' + esc(i.title) +
               ' <span class="eyd-ins-sev">' + esc(sev) + '</span></p>' +
               '<p class="eyd-ins-d">' + esc(i.detail) + '</p></div>';
        });
        h += '</div>';
        if (res.recommended_metrics && res.recommended_metrics.length) {
          h += '<p class="eyd-ai-t" style="margin:18px 0 8px;font-size:13px">Metrics the model suggests adding</p><div class="eyd-ins">';
          res.recommended_metrics.forEach(function (m) {
            h += '<div class="eyd-ins-item eyd-sev-info"><p class="eyd-ins-t">' + esc(m.metric) +
                 ' <span class="eyd-ins-sev">' + esc(m.chart) + '</span></p>' +
                 '<p class="eyd-ins-d">' + esc(m.why) + '</p></div>';
          });
          h += '</div>';
        }
        out.innerHTML = h;
      })
      .catch(function (e) {
        out.innerHTML = '<p class="eyd-empty">AI request failed: ' + esc(e.message) + '</p>';
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Generate AI analysis';
      });
  }

  // ---------------------------------------------------------------- bootstrap

  function load() {
    var months = el('range').value;
    el('viewer').textContent = 'Loading…';
    fetch(API + '/overview?months=' + months, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) { render(j.result); })
      .catch(function (e) {
        el('viewer').textContent = 'Failed to load: ' + e.message;
      });
  }

  function boot() {
    var msg = el('boot-msg');
    if (typeof echarts === 'undefined') {
      if (msg) msg.textContent = 'The charting library did not load from any source on this instance.';
      return;
    }
    // Assets are all present -- clear the bootstrap notice.
    if (msg && msg.parentNode) msg.parentNode.removeChild(msg);
    el('btn-refresh').addEventListener('click', load);
    el('btn-ai').addEventListener('click', runAI);
    el('range').addEventListener('change', load);
    el('btn-acl').addEventListener('click', loadAcl);

    window.addEventListener('resize', function () {
      charts.forEach(function (c) { try { c.resize(); } catch (e) {} });
    });
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (STATE.data) render(STATE.data);
      });
    }

    load();
    loadAcl();
  }

  // The page's inline loader owns timing: it resolves the charting library from
  // whichever instance source works, then calls this.
  window.EYD_BOOT = boot;
})();
