/**
 * cmd_render. The client renderer for the COMMAND dashboards.
 *
 * Reads the payload the server embedded in the page and builds the DOM. There is
 * no charting library: every mark is SVG generated here.
 *
 * That is a deliberate decision and it is worth stating, because reaching for
 * ECharts would be the obvious move. Three reasons not to:
 *
 *   1. Licensing. The client's first and most emphatic concern was third-party
 *      components deployed inside their instance. No library means nothing to
 *      disclose, no Apache-2.0 notice obligation, and no OEM question if this ever
 *      ships through the Store.
 *   2. Payload. The chart engine is the biggest single lever on a 250 KB budget,
 *      and a custom build of a general-purpose library still carries the
 *      abstractions needed to be general purpose.
 *   3. Fidelity. The approved brand kit specifies 25 chart forms as hand-authored
 *      SVG with particular mark geometry: 4px rounded data-ends anchored to the
 *      baseline, a 2px surface gap between adjacent fills, selective direct
 *      labels. Reproducing that through a library's theming layer is more work
 *      than drawing it.
 *
 * The cost is that each form is implemented by hand, so the FORMS table below is
 * the honest list of what renders. Anything the engine can emit that is not in
 * that table falls back to a labelled table view rather than a blank panel, which
 * is also the accessibility fallback every chart needs anyway.
 *
 * ES5. No build step, no transpiler, loaded by src from a UI Script.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  /* Categorical order is fixed and never cycled. These are the validated light
     theme steps from the brand kit: OKLab lightness band, chroma floor, CVD
     separation against the white chart surface. A ninth series is never a
     generated hue, it folds into Other. */
  var CAT = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
  var OTHER = '--c-other';
  var SEQ = ['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7'];

  // ── small helpers ────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (attrs.hasOwnProperty(k) && attrs[k] !== null && attrs[k] !== undefined) {
          n.setAttribute(k, String(attrs[k]));
        }
      }
    }
    return n;
  }

  function svgRoot(w, h) {
    var s = svgEl('svg', {
      viewBox: '0 0 ' + w + ' ' + h,
      'class': 'ch',
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img'
    });
    return s;
  }

  function v(token) { return 'var(' + token + ')'; }

  function catColour(i) { return i < CAT.length ? v(CAT[i]) : v(OTHER); }

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return '0';
    var neg = n < 0;
    var s = String(Math.round(Math.abs(n)));
    var out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c % 3 === 0 && i > 0) out = ',' + out;
    }
    return (neg ? '-' : '') + out;
  }

  /* "1 records" appeared in the page subheader, in every chart tooltip, and in the
     reason text on every rejected drill level, because the count and the noun were
     concatenated at twenty-one separate sites. Small, but it is the kind of thing a
     client reads as carelessness in everything else on the page. */
  function recs(n) {
    return fmt(n) + (Math.round(Math.abs(n)) === 1 ? ' record' : ' records');
  }

  function compact(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'b';
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
    if (a >= 10000) return Math.round(n / 1000) + 'k';
    return fmt(n);
  }

  function pct(x, digits) {
    var p = x * 100;
    if (digits === undefined) digits = (p < 10 && p > 0) ? 1 : 0;
    return p.toFixed(digits) + '%';
  }

  function label(row) {
    if (row.label !== undefined && row.label !== null && row.label !== '') return row.label;
    if (row.key === '' || row.key === null) return '(none)';
    return String(row.key);
  }

  function truncate(s, n) {
    /* Collapse whitespace first. Values coming off the instance can carry
       newlines and tabs, and a label with a line break in it breaks a legend
       row's layout with no obvious cause. */
    s = String(s).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    return s.length > n ? s.substring(0, n - 1) + '…' : s;
  }

  /** Nice axis ceiling, so the top gridline is a number a person would choose. */
  function niceMax(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var norm = v / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function sum(rows) {
    var t = 0;
    for (var i = 0; i < rows.length; i++) t += rows[i].count;
    return t;
  }

  /* Rows plus the folded remainder, as one list. The Other slice is a real
     category with its own reserved colour, never a gap in the chart. */
  function withOther(panel) {
    var rows = (panel.rows && panel.rows.series) ? panel.rows.series.slice() : [];
    var o = panel.rows && panel.rows.other;
    if (o && o.count > 0) {
      rows.push({ key: '__other__', label: 'Other (' + o.groups + ')', count: o.count,
                  isOther: true });
    }
    return rows;
  }

  // ── chart forms ──────────────────────────────────────────────────────────

  /* Logical chart width, set per panel before each draw.
   *
   * The SVG scales to its container, so a 520-wide viewBox in a full-width panel
   * was being blown up about 2.4x and taking every 9.5px axis label with it. The
   * marks looked right and the type looked like a different design. Widening the
   * viewBox for a full-width panel keeps the ratio of type to mark constant, which
   * is the thing that has to stay fixed. */
  var W = 520;
  var W_SINGLE = 520, W_SPAN2 = 1080;

  /** One series over time. The line is the mark; area only when it is a level. */
  function drawLine(panel, filled) {
    var pts = panel.points || [];
    var h = 200, padL = 40, padR = 12, padT = 16, padB = 26;
    var s = svgRoot(W, h);
    if (!pts.length) return s;

    /* The forecast extends the x-domain, so the scale has to know about it before
       anything is placed. Fitting the axis to the observations and then drawing a
       projection past the right edge is how a forecast ends up outside its own box. */
    var ann = panel.annotation || null;
    var ahead = (ann && ann.forecast) ? ann.forecast.length : 0;
    var slots = pts.length + ahead;

    var peak = Math.max.apply(null, pts.map(function (p) { return p.count; }));
    if (ann && ann.forecast) {
      for (var fi = 0; fi < ann.forecast.length; fi++) {
        if (ann.forecast[fi].hi > peak) peak = ann.forecast[fi].hi;
      }
    }
    var max = niceMax(peak);
    var iw = W - padL - padR, ih = h - padT - padB;
    var x = function (i) { return padL + (slots <= 1 ? iw / 2 : (i / (slots - 1)) * iw); };
    var y = function (c) { return padT + ih - (c / max) * ih; };

    // gridlines and y labels
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (g / 4) * ih;
      s.appendChild(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, 'class': 'gl' }));
      s.appendChild(text(padL - 8, gy + 3, compact(max - (g / 4) * max), 'tk', 'end'));
    }

    // The open period is drawn dashed and excluded from the solid path, because a
    // partial bucket read as a fall is the single most common dashboard lie.
    var lastClosed = pts.length - 1;
    while (lastClosed > 0 && pts[lastClosed].partial) lastClosed--;

    var solid = [], dashed = [];
    for (var i = 0; i <= lastClosed; i++) solid.push([x(i), y(pts[i].count)]);
    for (var j = lastClosed; j < pts.length; j++) dashed.push([x(j), y(pts[j].count)]);

    if (filled && solid.length > 1) {
      var d = 'M' + solid[0][0] + ',' + (padT + ih);
      for (var k = 0; k < solid.length; k++) d += 'L' + solid[k][0] + ',' + solid[k][1];
      d += 'L' + solid[solid.length - 1][0] + ',' + (padT + ih) + 'Z';
      s.appendChild(svgEl('path', { d: d, fill: 'url(#cmdArea)', stroke: 'none' }));
    }

    s.appendChild(svgEl('path', { d: poly(solid), fill: 'none', stroke: v('--c1'),
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (dashed.length > 1) {
      s.appendChild(svgEl('path', { d: poly(dashed), fill: 'none', stroke: v('--c1'),
        'stroke-width': 2, 'stroke-dasharray': '3 3', opacity: 0.65 }));
    }

    /* ── the analytics layer ──
     *
     * Fitted line, projection with a widening band, and anomaly rings. Drawn under
     * the observations so the data stays the foreground, and every element is
     * labelled: this is least squares over the closed buckets, not a model, and the
     * panel caption says so. The band widens with distance because the uncertainty
     * three periods out is not the uncertainty one period out, and drawing it at a
     * constant width would be the more confident-looking lie. */
    if (ann) {
      if (ann.forecast && ann.forecast.length) {
        var lastPt = pts.length - 1;
        var upper = [[x(lastPt), y(pts[lastPt].count)]];
        var lower = [[x(lastPt), y(pts[lastPt].count)]];
        var mid = [[x(lastPt), y(pts[lastPt].count)]];
        for (var q = 0; q < ann.forecast.length; q++) {
          var f = ann.forecast[q];
          upper.push([x(f.index), y(Math.min(max, f.hi))]);
          lower.push([x(f.index), y(f.lo)]);
          mid.push([x(f.index), y(f.value)]);
        }
        var band = 'M' + upper[0][0] + ',' + upper[0][1];
        for (var u = 1; u < upper.length; u++) band += 'L' + upper[u][0] + ',' + upper[u][1];
        for (var l = lower.length - 1; l >= 0; l--) band += 'L' + lower[l][0] + ',' + lower[l][1];
        band += 'Z';
        s.appendChild(svgEl('path', { d: band, fill: v('--c1'), opacity: 0.12 }));
        s.appendChild(svgEl('path', { d: poly(mid), fill: 'none', stroke: v('--c1'),
          'stroke-width': 1.6, 'stroke-dasharray': '5 4', opacity: 0.75 }));
        var lastF = ann.forecast[ann.forecast.length - 1];
        s.appendChild(valueLabel(x(lastF.index), y(lastF.value) - 9,
          'projected ' + fmt(lastF.value), 'tk'));
      }

      s.appendChild(svgEl('line', {
        x1: x(ann.fitFrom.index), y1: y(Math.max(0, ann.fitFrom.value)),
        x2: x(ann.fitTo.index), y2: y(Math.max(0, ann.fitTo.value)),
        stroke: v('--ink-3'), 'stroke-width': 1.4, 'stroke-dasharray': '2 3',
        opacity: 0.8 }));
    }

    // markers, and a direct label on the last closed point only
    for (var m = 0; m < pts.length; m++) {
      var mk = svgEl('circle', { cx: x(m), cy: y(pts[m].count), r: 3.4,
        fill: v('--surface'), stroke: v('--c1'), 'stroke-width': 2,
        opacity: pts[m].partial ? 0.6 : 1 });
      tip(mk, [pts[m].label, recs(pts[m].count),
               pts[m].partial ? 'this period is still open' : 'complete period']);
      s.appendChild(mk);
    }

    if (ann && ann.anomalies) {
      for (var a = 0; a < ann.anomalies.length; a++) {
        var an = ann.anomalies[a];
        var ring = svgEl('circle', { cx: x(an.index), cy: y(an.value), r: 8,
          fill: 'none', stroke: v('--c4'), 'stroke-width': 2, opacity: 0.9 });
        tip(ring, [pts[an.index] ? pts[an.index].label : 'Period',
                   fmt(an.value) + ' against an expected ' + fmt(an.expected),
                   an.sigma + ' standard deviations from the fitted trend',
                   'A marker to look at, not a significance test.']);
        s.appendChild(ring);
      }
    }
    s.appendChild(valueLabel(x(lastClosed), y(pts[lastClosed].count) - 10,
      fmt(pts[lastClosed].count), 'vl'));

    // x labels, thinned so they never collide
    /* Thinned, and the final label is only forced when it is not adjacent to one
       already drawn. Forcing it unconditionally overlapped "Jul '26" with
       "Aug '26" into an unreadable smear. */
    var every = Math.max(1, Math.ceil(slots / (W >= 800 ? 9 : 6)));
    var last = pts.length - 1;
    for (var t = 0; t < pts.length; t++) {
      var onStep = (t % every === 0);
      var isLast = (t === last);
      if (!onStep && !isLast) continue;
      if (isLast && !onStep && (last - Math.floor(last / every) * every) < 2) continue;
      s.appendChild(valueLabel(x(t), h - 8, pts[t].label, 'tk'));
    }
    s.appendChild(svgEl('line', { x1: padL, y1: padT + ih, x2: W - padR, y2: padT + ih,
      'class': 'bl' }));
    return s;
  }

  function poly(p) {
    if (!p.length) return '';
    var d = 'M' + p[0][0] + ',' + p[0][1];
    for (var i = 1; i < p.length; i++) d += 'L' + p[i][0] + ',' + p[i][1];
    return d;
  }

  /** Horizontal ranked bars. Length is the encoding, so it starts at zero. */
  function drawRankedBar(panel) {
    var rows = withOther(panel);
    var total = sum(rows);
    var barH = 22, gap = 8, padT = 6, padL = 136, padR = 58;
    var h = padT + rows.length * (barH + gap);
    var s = svgRoot(W, Math.max(h, 60));
    var max = niceMax(Math.max.apply(null, rows.map(function (r) { return r.count; })));
    var iw = W - padL - padR;

    for (var i = 0; i < rows.length; i++) {
      var yy = padT + i * (barH + gap);
      var w = Math.max(2, (rows[i].count / max) * iw);
      s.appendChild(text(padL - 10, yy + barH / 2 + 4, truncate(label(rows[i]), 18),
        'ct', 'end'));
      var rb = svgEl('rect', {
        x: padL, y: yy, width: w, height: barH, rx: 4,
        fill: rows[i].isOther ? v(OTHER) : v('--c1')
      });
      tip(rb, [label(rows[i]), recs(rows[i].count),
               pct(rows[i].count / (total || 1)) + ' of the total']);
      if (!rows[i].isOther) drillable(rb, panel.field, rows[i].key);
      s.appendChild(rb);
      var lx = padL + w + 8;
      s.appendChild(lx > W - 44
        ? text(W - 3, yy + barH / 2 + 4, fmt(rows[i].count), 'vl', 'end')
        : text(lx, yy + barH / 2 + 4, fmt(rows[i].count), 'vl', 'start'));
    }
    s.appendChild(svgEl('line', { x1: padL, y1: 0, x2: padL, y2: h, 'class': 'bl' }));
    return s;
  }

  /** Vertical columns, drawn in the data's own order rather than ranked. */
  function drawColumn(panel) {
    var rows = withOther(panel);
    var colTotal = sum(rows);
    var h = 200, padL = 40, padR = 10, padT = 18, padB = 30;
    var s = svgRoot(W, h);
    var max = niceMax(Math.max.apply(null, rows.map(function (r) { return r.count; })));
    var iw = W - padL - padR, ih = h - padT - padB;
    var slot = iw / rows.length, bw = Math.min(46, slot * 0.62);

    for (var g = 0; g <= 3; g++) {
      var gy = padT + (g / 3) * ih;
      s.appendChild(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, 'class': 'gl' }));
      s.appendChild(text(padL - 8, gy + 3, compact(max - (g / 3) * max), 'tk', 'end'));
    }
    for (var i = 0; i < rows.length; i++) {
      var cx = padL + slot * i + slot / 2;
      var bh = Math.max(2, (rows[i].count / max) * ih);
      var cb = svgEl('rect', { x: cx - bw / 2, y: padT + ih - bh, width: bw,
        height: bh, rx: 4, fill: rows[i].isOther ? v(OTHER) : v('--c1') });
      tip(cb, [label(rows[i]), recs(rows[i].count),
               pct(rows[i].count / (colTotal || 1)) + ' of the total']);
      if (!rows[i].isOther) drillable(cb, panel.field, rows[i].key);
      s.appendChild(cb);
      s.appendChild(valueLabel(cx, padT + ih - bh - 6, fmt(rows[i].count), 'vl'));
      s.appendChild(valueLabel(cx, h - 10, truncate(label(rows[i]), 10), 'tk'));
    }
    s.appendChild(svgEl('line', { x1: padL, y1: padT + ih, x2: W - padR, y2: padT + ih,
      'class': 'bl' }));
    return s;
  }

  /**
   * A single stacked bar showing parts of a whole.
   *
   * Used for booleans and for ordered scales, where preserving the sequence
   * matters more than ranking by size. A 2px surface-coloured gap separates
   * adjacent segments so the boundary is legible without an outline.
   */
  function drawStackedProportion(panel, ordinal) {
    var rows = withOther(panel);
    var h = 116, padL = 2, padR = 2, barY = 20, barH = 42;
    var s = svgRoot(W, h);
    var total = sum(rows);
    if (!total) return emptyChart(s, h, 'No records in this slice, so there is no whole to divide.');

    var x = padL, iw = W - padL - padR;
    for (var i = 0; i < rows.length; i++) {
      var w = (rows[i].count / total) * iw;
      var seg = Math.max(0, w - (i < rows.length - 1 ? 2 : 0));
      var colour = rows[i].isOther ? v(OTHER)
                 : ordinal ? v(SEQ[Math.min(SEQ.length - 1,
                     2 + Math.floor(i * (SEQ.length - 3) / Math.max(1, rows.length - 1)))])
                 : catColour(i);
      var sg = svgEl('rect', { x: x, y: barY, width: seg, height: barH,
        rx: i === 0 || i === rows.length - 1 ? 4 : 0, fill: colour });
      tip(sg, [label(rows[i]), recs(rows[i].count),
               pct(rows[i].count / total) + ' of the total']);
      if (!rows[i].isOther) drillable(sg, panel.field, rows[i].key);
      s.appendChild(sg);
      // Only label a segment wide enough to hold the text.
      if (w > 46) {
        s.appendChild(text(x + seg / 2, barY + barH / 2 + 4,
          pct(rows[i].count / total), 'vlOn', 'middle'));
      }
      x += w;
    }
    // legend, because identity must never be colour alone
    var lx = 2, ly = barY + barH + 22;
    for (var j = 0; j < rows.length && j < 7; j++) {
      var colour2 = rows[j].isOther ? v(OTHER)
                  : ordinal ? v(SEQ[Math.min(SEQ.length - 1,
                      2 + Math.floor(j * (SEQ.length - 3) / Math.max(1, rows.length - 1)))])
                  : catColour(j);
      s.appendChild(svgEl('rect', { x: lx, y: ly - 8, width: 9, height: 9, rx: 2,
        fill: colour2 }));
      var txt = truncate(label(rows[j]), 16);
      s.appendChild(text(lx + 14, ly, txt, 'ct', 'start'));
      lx += 14 + txt.length * 6.1 + 18;
      if (lx > W - 90 && j < rows.length - 1) {
        s.appendChild(text(lx, ly, '+' + (rows.length - j - 1) + ' more', 'tk', 'start'));
        break;
      }
    }
    return s;
  }

  /** Donut, and semi-donut when there are very few slices. */
  function drawDonut(panel, semi) {
    var rows = withOther(panel);
    var h = semi ? 168 : 210;
    var s = svgRoot(W, h);
    var total = sum(rows);
    if (!total) return emptyChart(s, h, 'No records in this slice, so there is no whole to divide.');

    var cx = 132, cy = semi ? 132 : 104, r = 76, thick = 26;
    var legendX = Math.min(250, W * 0.42);
    var start = semi ? Math.PI : Math.PI * 1.5;
    var sweep = semi ? Math.PI : Math.PI * 2;

    var acc = 0;
    for (var i = 0; i < rows.length; i++) {
      var frac = rows[i].count / total;
      var a0 = start + acc * sweep;
      var a1 = start + (acc + frac) * sweep;
      // 2px surface gap between adjacent arcs
      var gapA = Math.min((a1 - a0) * 0.18, 0.035);
      var sl = svgEl('path', {
        d: arc(cx, cy, r, r - thick, a0, Math.max(a0, a1 - gapA)),
        fill: rows[i].isOther ? v(OTHER) : catColour(i)
      });
      tip(sl, [label(rows[i]), recs(rows[i].count),
               pct(rows[i].count / total) + ' of ' + fmt(total)]);
      if (!rows[i].isOther) drillable(sl, panel.field, rows[i].key);
      s.appendChild(sl);
      acc += frac;
    }

    // The total sits in the hole, which is the whole reason to use a donut.
    s.appendChild(text(cx, cy - (semi ? 26 : 2), compact(total), 'big', 'middle'));
    s.appendChild(text(cx, cy + (semi ? -10 : 18), 'total', 'tk', 'middle'));

    // legend with values, to the right
    var ly = 26;
    for (var j = 0; j < rows.length && j < 7; j++) {
      s.appendChild(svgEl('rect', { x: legendX, y: ly - 8, width: 9, height: 9, rx: 2,
        fill: rows[j].isOther ? v(OTHER) : catColour(j) }));
      s.appendChild(text(legendX + 14, ly, truncate(label(rows[j]), 22), 'ct', 'start'));
      s.appendChild(text(W - 4, ly, fmt(rows[j].count) + '  ' +
        pct(rows[j].count / total), 'vl', 'end'));
      ly += 22;
    }
    return s;
  }

  function arc(cx, cy, rOut, rIn, a0, a1) {
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    var x0 = cx + rOut * Math.cos(a0), y0 = cy + rOut * Math.sin(a0);
    var x1 = cx + rOut * Math.cos(a1), y1 = cy + rOut * Math.sin(a1);
    var x2 = cx + rIn * Math.cos(a1), y2 = cy + rIn * Math.sin(a1);
    var x3 = cx + rIn * Math.cos(a0), y3 = cy + rIn * Math.sin(a0);
    return 'M' + x0 + ',' + y0 +
           'A' + rOut + ',' + rOut + ' 0 ' + large + ' 1 ' + x1 + ',' + y1 +
           'L' + x2 + ',' + y2 +
           'A' + rIn + ',' + rIn + ' 0 ' + large + ' 0 ' + x3 + ',' + y3 + 'Z';
  }

  /**
   * Squarified treemap. Area carries magnitude when the mass is spread across
   * more categories than a bar chart can hold legibly.
   */
  function drawTreemap(panel) {
    var rows = withOther(panel);
    var h = 260;
    var s = svgRoot(W, h);
    var total = sum(rows);
    if (!total) return emptyChart(s, h, 'No records in this slice, so there is no area to divide.');

    var items = rows.map(function (r, i) {
      return { row: r, value: r.count, idx: i };
    }).filter(function (x) { return x.value > 0; });

    var cells = squarify(items, 0, 0, W, h, total);
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var step = Math.min(SEQ.length - 1,
        1 + Math.floor((1 - i / Math.max(1, cells.length - 1)) * (SEQ.length - 2)));
      var tm = svgEl('rect', {
        x: c.x + 1, y: c.y + 1,
        width: Math.max(0, c.w - 2), height: Math.max(0, c.h - 2),
        rx: 3,
        fill: c.item.row.isOther ? v(OTHER) : v(SEQ[step])
      });
      tip(tm, [label(c.item.row), recs(c.item.value),
               pct(c.item.value / total) + ' of the total']);
      if (!c.item.row.isOther) drillable(tm, panel.field, c.item.row.key);
      s.appendChild(tm);
      // Label only where it fits. A clipped label is worse than none.
      if (c.w > 62 && c.h > 34) {
        var onDark = step >= 4;
        s.appendChild(text(c.x + 9, c.y + 20,
          truncate(label(c.item.row), Math.floor((c.w - 16) / 6.2)),
          onDark ? 'ctOn' : 'ct', 'start'));
        s.appendChild(text(c.x + 9, c.y + 38, fmt(c.item.value),
          onDark ? 'vlOn' : 'vl', 'start'));
      }
    }
    return s;
  }

  function squarify(items, x, y, w, h, total) {
    var out = [];
    var scale = (w * h) / total;
    var rest = items.slice();

    while (rest.length) {
      var horizontal = w >= h;
      var side = horizontal ? h : w;
      var row = [], rowArea = 0, best = Infinity;

      for (var i = 0; i < rest.length; i++) {
        var area = rest[i].value * scale;
        var testArea = rowArea + area;
        var thickness = testArea / side;
        var worst = 0;
        for (var j = 0; j <= i; j++) {
          var a = rest[j].value * scale;
          var len = a / thickness;
          var ratio = Math.max(thickness / len, len / thickness);
          if (ratio > worst) worst = ratio;
        }
        if (worst > best && row.length) break;
        row.push(rest[i]); rowArea = testArea; best = worst;
      }

      var thick = rowArea / side;
      var off = 0;
      for (var k = 0; k < row.length; k++) {
        var a2 = row[k].value * scale;
        var len2 = a2 / thick;
        out.push(horizontal
          ? { item: row[k], x: x, y: y + off, w: thick, h: len2 }
          : { item: row[k], x: x + off, y: y, w: len2, h: thick });
        off += len2;
      }
      if (horizontal) { x += thick; w -= thick; } else { y += thick; h -= thick; }
      rest = rest.slice(row.length);
      if (w <= 0.5 || h <= 0.5) break;
    }
    return out;
  }

  /** Histogram of a numeric field. Bins are equal width, so gaps are meaningful. */
  function drawHistogram(panel) {
    var rows = (panel.rows && panel.rows.series) ? panel.rows.series : [];
    var nums = [];
    for (var i = 0; i < rows.length; i++) {
      var x = parseFloat(rows[i].key);
      if (!isNaN(x)) nums.push({ x: x, n: rows[i].count });
    }
    if (nums.length < 2) return drawColumn(panel);

    nums.sort(function (a, b) { return a.x - b.x; });
    var lo = nums[0].x, hi = nums[nums.length - 1].x;
    if (hi === lo) return drawColumn(panel);

    var bins = Math.min(16, Math.max(6, Math.round(Math.sqrt(nums.length))));
    var width = (hi - lo) / bins;
    var buckets = [];
    for (var b = 0; b < bins; b++) buckets.push(0);
    for (var j = 0; j < nums.length; j++) {
      var idx = Math.min(bins - 1, Math.floor((nums[j].x - lo) / width));
      buckets[idx] += nums[j].n;
    }

    var h = 200, padL = 40, padR = 10, padT = 18, padB = 30;
    var s = svgRoot(W, h);
    var max = niceMax(Math.max.apply(null, buckets));
    var iw = W - padL - padR, ih = h - padT - padB;
    var slot = iw / bins;

    for (var g = 0; g <= 3; g++) {
      var gy = padT + (g / 3) * ih;
      s.appendChild(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, 'class': 'gl' }));
      s.appendChild(text(padL - 8, gy + 3, compact(max - (g / 3) * max), 'tk', 'end'));
    }
    for (var k = 0; k < bins; k++) {
      var bh = buckets[k] === 0 ? 0 : Math.max(2, (buckets[k] / max) * ih);
      // Histogram bars touch, with a 1px surface gap, because the axis is continuous.
      var hb = svgEl('rect', { x: padL + slot * k + 0.5, y: padT + ih - bh,
        width: Math.max(1, slot - 1), height: bh, rx: 2, fill: v('--c1') });
      tip(hb, [num(lo + k * width) + ' to ' + num(lo + (k + 1) * width),
               recs(buckets[k])]);
      s.appendChild(hb);
    }
    s.appendChild(text(padL, h - 10, compact(lo), 'tk', 'start'));
    s.appendChild(text(W - padR, h - 10, compact(hi), 'tk', 'end'));
    s.appendChild(text(padL + iw / 2, h - 10, bins + ' bins', 'tk', 'middle'));
    s.appendChild(svgEl('line', { x1: padL, y1: padT + ih, x2: W - padR, y2: padT + ih,
      'class': 'bl' }));
    return s;
  }

  function drawStatTile(panel) {
    var rows = withOther(panel);
    var s = svgRoot(W, 120);
    s.appendChild(text(3, 62, compact(sum(rows)), 'huge', 'start'));
    s.appendChild(text(3, 88, panel.fieldLabel || '', 'tk', 'start'));
    return s;
  }


  /**
   * A value label that cannot leave the chart box.
   *
   * Anchoring every label 'middle' overflows the viewBox at both ends: the last
   * point of a line sits at W minus the right pad, and a four-digit number centred
   * there extends about 13px past the edge. Measured, the line chart ran to x=530
   * in a 520-wide box. With overflow:visible that draws but collides with the next
   * panel, and inside the mobile scroll container it is simply clipped.
   */
  function valueLabel(x, y, str, cls) {
    var pad = 3;
    if (x > W - 34) return text(W - pad, y, str, cls, 'end');
    if (x < 34) return text(pad, y, str, cls, 'start');
    return text(x, y, str, cls, 'middle');
  }

  function text(x, y, str, cls, anchor) {
    var t = svgEl('text', { x: x, y: y, 'class': cls, 'text-anchor': anchor || 'start' });
    t.textContent = String(str);
    return t;
  }

  /** The fallback, and also the accessibility view every chart needs anyway. */
  function drawTable(panel) {
    var rows = withOther(panel);
    var total = sum(rows);
    var wrap = el('div', 'tbl-wrap');
    var t = el('table', 'tbl');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', 'l', panel.fieldLabel || 'Value'));
    hr.appendChild(el('th', 'n', 'Records'));
    hr.appendChild(el('th', 'n', 'Share'));
    thead.appendChild(hr);
    t.appendChild(thead);
    var tb = el('tbody');
    for (var i = 0; i < rows.length; i++) {
      var tr = el('tr');
      tr.appendChild(el('td', 'l', label(rows[i])));
      tr.appendChild(el('td', 'n', fmt(rows[i].count)));
      tr.appendChild(el('td', 'n', total ? pct(rows[i].count / total) : '0%'));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  // ── shared plot scaffolding ──────────────────────────────────────────────

  /**
   * A plot box with its scales. Every form below draws into one of these rather
   * than recomputing padding and mapping functions, which is what keeps the axis
   * type, the gridline weight and the baseline position identical across fifteen
   * charts that were otherwise written separately.
   */
  function plot(h, padL, padR, padT, padB) {
    var s = svgRoot(W, h);
    var iw = W - padL - padR, ih = h - padT - padB;
    return {
      s: s, h: h, iw: iw, ih: ih,
      padL: padL, padR: padR, padT: padT, padB: padB,
      x0: padL, y0: padT, x1: padL + iw, y1: padT + ih,
      xAt: function (i, n) {
        return padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
      },
      band: function (i, n) { return padL + (iw / n) * (i + 0.5); },
      bandW: function (n) { return iw / n; }
    };
  }

  /** Horizontal gridlines with labels, and the baseline. */
  function yAxis(p, max, steps, fmtFn) {
    steps = steps || 4;
    fmtFn = fmtFn || compact;
    for (var g = 0; g <= steps; g++) {
      var gy = p.y0 + (g / steps) * p.ih;
      p.s.appendChild(svgEl('line', { x1: p.x0, y1: gy, x2: p.x1, y2: gy, 'class': 'gl' }));
      p.s.appendChild(text(p.x0 - 8, gy + 3, fmtFn(max - (g / steps) * max), 'tk', 'end'));
    }
    p.s.appendChild(svgEl('line', { x1: p.x0, y1: p.y1, x2: p.x1, y2: p.y1, 'class': 'bl' }));
  }

  /**
   * A legend row. Present whenever there are two or more series, because identity
   * must never be carried by colour alone — that is the accessibility floor, and it
   * is also just easier to read.
   */
  function legendRow(p, items, y) {
    var lx = p.x0, i;
    for (i = 0; i < items.length; i++) {
      var txt = truncate(items[i].label, 18);
      if (lx + 14 + txt.length * 6.1 > p.x1 - 40 && i < items.length - 1) {
        p.s.appendChild(text(lx, y, '+' + (items.length - i) + ' more', 'tk', 'start'));
        break;
      }
      p.s.appendChild(svgEl('rect', { x: lx, y: y - 8, width: 9, height: 9, rx: 2,
        fill: items[i].colour }));
      p.s.appendChild(text(lx + 14, y, txt, 'ct', 'start'));
      lx += 14 + txt.length * 6.1 + 18;
    }
  }

  /**
   * Attaches a hover report to a mark.
   *
   * The brand kit's specification is that a hover returns a small report rather
   * than a single number, so `lines` is a list and the tooltip renders it as rows.
   * Carried as a data attribute rather than a JS property because the handler is
   * delegated at the panel, which means it keeps working for marks added later and
   * costs one listener per panel instead of one per mark.
   */
  function tip(node, lines) {
    node.setAttribute('data-tip', lines.join('\n'));
    node.setAttribute('tabindex', '0');
    return node;
  }

  /** Marks a mark as a drill target, so a click filters rather than navigates. */
  function drillable(node, field, key) {
    if (field === null || field === undefined) return node;
    node.setAttribute('data-drill-field', field);
    node.setAttribute('data-drill-key', key === null || key === undefined ? '' : key);
    node.setAttribute('class', (node.getAttribute('class') || '') + ' hit');
    return node;
  }

  function seriesColour(i, isOther) {
    return isOther ? v(OTHER) : catColour(i);
  }

  /** A sequential step for a magnitude between 0 and 1. Never a rainbow. */
  function seqStep(t) {
    if (t <= 0) return v('--q0');
    var i = Math.min(SEQ.length - 1, Math.max(0, Math.round(t * (SEQ.length - 1))));
    return v(SEQ[i]);
  }

  /** Ink that stays legible on a sequential fill. */
  function onSeq(t) { return t > 0.55 ? 'vlOn' : 'vl'; }

  /**
   * The nothing-to-draw state, said out loud.
   *
   * Several forms cannot draw a total of zero -- there is no proportion of nothing
   * to take an angle or an area from -- and every one of them used to handle that
   * by returning an SVG with nothing in it. The panel then rendered as an empty box
   * under a confident title, which is indistinguishable from a chart that failed,
   * and is precisely the "looks half finished" complaint in miniature.
   *
   * The payload builders already refuse to emit a panel with no records, so this
   * should be unreachable through the normal path. It exists because "should be
   * unreachable" is not a rendering strategy, and because a filtered drill can
   * arrive at an empty slice of a panel that was legitimate a moment earlier.
   */
  function emptyChart(s, h, message) {
    s.appendChild(svgEl('rect', { x: 1, y: 1, width: W - 2, height: h - 2, rx: 8,
      fill: 'none', stroke: v('--edge'), 'stroke-width': 1,
      'stroke-dasharray': '4 4' }));
    s.appendChild(text(W / 2, h / 2 + 4, message, 'tk', 'middle'));
    return s;
  }

  // ── time by category ─────────────────────────────────────────────────────

  /**
   * Several series over time, each with its own baseline.
   *
   * This used to be aliased to the single-series line renderer, which drew the
   * first series and silently discarded the rest. It was the worst class of bug in
   * a chart: the output looked correct and was answering a different question.
   */
  function drawLineMulti(panel) {
    var periods = panel.periods || [];
    var series = (panel.series || []).slice();
    if (panel.other) series.push(panel.other);
    if (!periods.length || !series.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No series to draw over this window.');
    }

    var p = plot(240, 44, 14, 16, 54);
    var max = 0, i, j;
    for (i = 0; i < series.length; i++) {
      for (j = 0; j < series[i].counts.length; j++) {
        if (series[i].counts[j] > max) max = series[i].counts[j];
      }
    }
    max = niceMax(max);
    yAxis(p, max, 4);

    var y = function (c) { return p.y0 + p.ih - (c / max) * p.ih; };

    var lastClosed = periods.length - 1;
    while (lastClosed > 0 && periods[lastClosed].partial) lastClosed--;

    var items = [];
    for (i = 0; i < series.length; i++) {
      var colour = seriesColour(i, series[i].isOther);
      items.push({ label: series[i].label || '(not set)', colour: colour });

      var solid = [], dashed = [];
      for (j = 0; j <= lastClosed; j++) solid.push([p.xAt(j, periods.length), y(series[i].counts[j] || 0)]);
      for (j = lastClosed; j < periods.length; j++) dashed.push([p.xAt(j, periods.length), y(series[i].counts[j] || 0)]);

      p.s.appendChild(svgEl('path', { d: poly(solid), fill: 'none', stroke: colour,
        'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (dashed.length > 1) {
        p.s.appendChild(svgEl('path', { d: poly(dashed), fill: 'none', stroke: colour,
          'stroke-width': 2, 'stroke-dasharray': '3 3', opacity: 0.65 }));
      }
      for (j = 0; j < periods.length; j++) {
        var mk = svgEl('circle', {
          cx: p.xAt(j, periods.length), cy: y(series[i].counts[j] || 0), r: 3.2,
          fill: v('--surface'), stroke: colour, 'stroke-width': 2,
          opacity: periods[j].partial ? 0.6 : 1
        });
        tip(mk, [series[i].label || '(not set)', periods[j].label,
                 recs(series[i].counts[j] || 0) +
                 (periods[j].partial ? '  (period still open)' : '')]);
        drillable(mk, panel.field, series[i].key);
        p.s.appendChild(mk);
      }
    }

    xTicks(p, periods);
    legendRow(p, items, p.h - 10);
    return p.s;
  }

  /** Thinned period labels along the bottom of a time plot. */
  function xTicks(p, periods) {
    var every = Math.max(1, Math.ceil(periods.length / (W >= 800 ? 9 : 6)));
    var last = periods.length - 1;
    for (var t = 0; t < periods.length; t++) {
      var onStep = (t % every === 0);
      if (!onStep && t !== last) continue;
      if (t === last && !onStep && (last - Math.floor(last / every) * every) < 2) continue;
      p.s.appendChild(valueLabel(p.xAt(t, periods.length), p.y1 + 16, periods[t].label, 'tk'));
    }
  }

  /**
   * Share over time, stacked to 100%.
   *
   * The form for "too many categories to separate as lines". Because it is
   * normalised, the question it answers is genuinely different from the multi-line:
   * how the mix moved, not how the volume moved. Total volume is shown as a caption
   * so the reader is not left to infer it from a chart that deliberately hides it.
   */
  function drawStream(panel) {
    var periods = panel.periods || [];
    var series = (panel.series || []).slice();
    if (panel.other) series.push(panel.other);
    if (!periods.length || !series.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No series to draw over this window.');
    }

    var p = plot(240, 44, 14, 16, 54);
    var n = periods.length, i, j;

    var totals = [];
    for (j = 0; j < n; j++) {
      var t = 0;
      for (i = 0; i < series.length; i++) t += (series[i].counts[j] || 0);
      totals.push(t);
    }

    for (var g = 0; g <= 4; g++) {
      var gy = p.y0 + (g / 4) * p.ih;
      p.s.appendChild(svgEl('line', { x1: p.x0, y1: gy, x2: p.x1, y2: gy, 'class': 'gl' }));
      p.s.appendChild(text(p.x0 - 8, gy + 3, (100 - g * 25) + '%', 'tk', 'end'));
    }

    /* Cumulative offsets, bottom up, so each band sits on the one below it. */
    var below = [];
    for (j = 0; j < n; j++) below.push(0);

    var items = [];
    for (i = series.length - 1; i >= 0; i--) {
      var colour = seriesColour(i, series[i].isOther);
      var top = [], bottom = [];
      for (j = 0; j < n; j++) {
        var share = totals[j] > 0 ? (series[i].counts[j] || 0) / totals[j] : 0;
        var yBot = p.y0 + p.ih - (below[j] / 1) * p.ih;
        var yTop = p.y0 + p.ih - ((below[j] + share)) * p.ih;
        top.push([p.xAt(j, n), yTop]);
        bottom.push([p.xAt(j, n), yBot]);
        below[j] += share;
      }
      var d = 'M' + top[0][0] + ',' + top[0][1];
      for (j = 1; j < top.length; j++) d += 'L' + top[j][0] + ',' + top[j][1];
      for (j = bottom.length - 1; j >= 0; j--) d += 'L' + bottom[j][0] + ',' + bottom[j][1];
      d += 'Z';
      var band = svgEl('path', { d: d, fill: colour, stroke: v('--surface'),
        'stroke-width': 1 });
      var lastShare = totals[n - 1] > 0
        ? (series[i].counts[n - 1] || 0) / totals[n - 1] : 0;
      tip(band, [series[i].label || '(not set)',
                 'latest share ' + pct(lastShare),
                 recs(series[i].total) + ' across the window']);
      drillable(band, panel.field, series[i].key);
      p.s.appendChild(band);
    }
    for (i = 0; i < series.length; i++) {
      items.push({ label: series[i].label || '(not set)',
                   colour: seriesColour(i, series[i].isOther) });
    }

    xTicks(p, periods);
    legendRow(p, items, p.h - 10);
    return p.s;
  }

  /**
   * A grid of small panels, one per category, sharing one scale.
   *
   * Sharing the scale is the whole point and the most common way this form is got
   * wrong: with a free scale per facet, every panel looks equally busy and the
   * comparison the grid exists to enable is destroyed.
   */
  function drawSmallMultiples(panel) {
    var periods = panel.periods || [];
    var series = (panel.series || []).slice();
    if (panel.other) series.push(panel.other);
    if (!periods.length || !series.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No series to draw over this window.');
    }

    var cols = W >= 800 ? 3 : 2;
    var rows = Math.ceil(series.length / cols);
    var cw = W / cols, chH = 96;
    var s = svgRoot(W, rows * chH + 8);

    var max = 0, i, j;
    for (i = 0; i < series.length; i++) {
      for (j = 0; j < series[i].counts.length; j++) {
        if (series[i].counts[j] > max) max = series[i].counts[j];
      }
    }
    max = niceMax(max);

    for (i = 0; i < series.length; i++) {
      var cx = (i % cols) * cw, cy = Math.floor(i / cols) * chH;
      var ix = cx + 8, iy = cy + 26, iw = cw - 20, ih = chH - 44;
      var colour = seriesColour(i, series[i].isOther);

      s.appendChild(text(cx + 8, cy + 15,
        truncate(series[i].label || '(not set)', Math.floor(cw / 7)), 'ct', 'start'));
      s.appendChild(text(cx + cw - 12, cy + 15, fmt(series[i].total), 'vl', 'end'));

      var pts = [];
      for (j = 0; j < periods.length; j++) {
        var xx = ix + (periods.length <= 1 ? iw / 2 : (j / (periods.length - 1)) * iw);
        var yy = iy + ih - ((series[i].counts[j] || 0) / max) * ih;
        pts.push([xx, yy]);
      }
      var d = 'M' + pts[0][0] + ',' + (iy + ih);
      for (j = 0; j < pts.length; j++) d += 'L' + pts[j][0] + ',' + pts[j][1];
      d += 'L' + pts[pts.length - 1][0] + ',' + (iy + ih) + 'Z';
      s.appendChild(svgEl('path', { d: d, fill: colour, opacity: 0.16 }));
      s.appendChild(svgEl('path', { d: poly(pts), fill: 'none', stroke: colour,
        'stroke-width': 2, 'stroke-linejoin': 'round' }));
      s.appendChild(svgEl('line', { x1: ix, y1: iy + ih, x2: ix + iw, y2: iy + ih,
        'class': 'bl' }));

      var hit = svgEl('rect', { x: cx, y: cy, width: cw, height: chH,
        fill: 'transparent' });
      tip(hit, [series[i].label || '(not set)',
                recs(series[i].total),
                'peak ' + fmt(Math.max.apply(null, series[i].counts)) +
                ' in one ' + (panel.grain || 'period')]);
      drillable(hit, panel.field, series[i].key);
      s.appendChild(hit);
    }

    s.appendChild(text(4, rows * chH + 5,
      'All panels share one scale, topping at ' + fmt(max) + ', so the heights ' +
      'compare across categories.', 'tk', 'start'));
    return s;
  }

  /** Two ranked positions joined by a line. Movement is the slope. */
  function drawSlope(panel) {
    var rows = panel.rows || [];
    if (!rows.length) return svgRoot(W, 60);

    var p = plot(28 + rows.length * 26 + 40, 116, 116, 34, 20);
    var max = 0, i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].from > max) max = rows[i].from;
      if (rows[i].to > max) max = rows[i].to;
    }
    if (max <= 0) return emptyChart(p.s, p.h, 'No records in either period.');

    var top = p.y0, bot = p.y1;
    var y = function (val) { return bot - (val / max) * (bot - top); };

    p.s.appendChild(text(p.x0, p.y0 - 16, truncate(panel.fromLabel, 20), 'tk', 'middle'));
    p.s.appendChild(text(p.x1, p.y0 - 16, truncate(panel.toLabel, 20), 'tk', 'middle'));
    p.s.appendChild(svgEl('line', { x1: p.x0, y1: top, x2: p.x0, y2: bot, 'class': 'gl' }));
    p.s.appendChild(svgEl('line', { x1: p.x1, y1: top, x2: p.x1, y2: bot, 'class': 'gl' }));

    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var colour = catColour(i);
      var y1 = y(r.from), y2 = y(r.to);
      var line = svgEl('line', { x1: p.x0, y1: y1, x2: p.x1, y2: y2,
        stroke: colour, 'stroke-width': 2, 'stroke-linecap': 'round' });
      tip(line, [r.label || '(not set)',
                 panel.fromLabel + ': ' + fmt(r.from) + '  (rank ' + r.rankFrom + ')',
                 panel.toLabel + ': ' + fmt(r.to) + '  (rank ' + r.rankTo + ')',
                 (r.rankTo < r.rankFrom ? 'up ' + (r.rankFrom - r.rankTo)
                  : r.rankTo > r.rankFrom ? 'down ' + (r.rankTo - r.rankFrom)
                  : 'no change') + ' in rank']);
      drillable(line, panel.field, r.key);
      p.s.appendChild(line);

      p.s.appendChild(svgEl('circle', { cx: p.x0, cy: y1, r: 4, fill: colour }));
      p.s.appendChild(svgEl('circle', { cx: p.x1, cy: y2, r: 4, fill: colour }));
      p.s.appendChild(text(p.x0 - 10, y1 + 4,
        truncate(r.label || '(not set)', 15), 'ct', 'end'));
      p.s.appendChild(text(p.x1 + 10, y2 + 4, fmt(r.to), 'vl', 'start'));
    }
    return p.s;
  }

  /** Rank position at every period. Crossings are the story. */
  function drawBump(panel) {
    var path = panel.path || [], keys = panel.keys || [];
    if (path.length < 2 || !keys.length) return drawSlope(panel);

    var p = plot(60 + keys.length * 24, 130, 92, 30, 30);
    var n = path.length;
    var y = function (rank) {
      return p.y0 + ((rank - 1) / Math.max(1, keys.length - 1)) * p.ih;
    };

    var i, j;
    for (j = 0; j < n; j++) {
      p.s.appendChild(svgEl('line', { x1: p.xAt(j, n), y1: p.y0 - 6,
        x2: p.xAt(j, n), y2: p.y1 + 6, 'class': 'gl' }));
      p.s.appendChild(valueLabel(p.xAt(j, n), p.y1 + 22, path[j].label, 'tk'));
    }

    for (i = 0; i < keys.length; i++) {
      var colour = catColour(i);
      var pts = [];
      for (j = 0; j < n; j++) pts.push([p.xAt(j, n), y(path[j].rank[keys[i].key])]);
      var line = svgEl('path', { d: poly(pts), fill: 'none', stroke: colour,
        'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      tip(line, [keys[i].label || '(not set)',
                 'from rank ' + path[0].rank[keys[i].key] +
                 ' to rank ' + path[n - 1].rank[keys[i].key]]);
      drillable(line, panel.field, keys[i].key);
      p.s.appendChild(line);
      for (j = 0; j < n; j++) {
        p.s.appendChild(svgEl('circle', { cx: pts[j][0], cy: pts[j][1], r: 4.5,
          fill: colour, stroke: v('--surface'), 'stroke-width': 2 }));
      }
      p.s.appendChild(text(p.x0 - 10, y(path[0].rank[keys[i].key]) + 4,
        truncate(keys[i].label || '(not set)', 17), 'ct', 'end'));
      p.s.appendChild(text(p.x1 + 10, y(path[n - 1].rank[keys[i].key]) + 4,
        '#' + path[n - 1].rank[keys[i].key], 'vl', 'start'));
    }
    return p.s;
  }

  /**
   * A waterfall: what moved the total between two periods.
   *
   * The bars reconcile the two ends exactly, because the contributions are computed
   * to sum to the change rather than sampled from the top few. That is the property
   * that makes this form worth drawing at all: if the steps do not close the gap,
   * it is a bar chart with a running total drawn on it.
   */
  function drawWaterfall(panel) {
    var steps = panel.steps || [];
    if (!steps.length) {
      return emptyChart(svgRoot(W, 80), 80, 'Nothing moved between these periods.');
    }

    var p = plot(230, 44, 14, 20, 56);
    var n = steps.length + 2;
    var slot = p.iw / n, bw = Math.min(52, slot * 0.62);

    var running = panel.start, lo = Math.min(panel.start, panel.end),
        hi = Math.max(panel.start, panel.end), i;
    for (i = 0; i < steps.length; i++) {
      running += steps[i].delta;
      if (running < lo) lo = running;
      if (running > hi) hi = running;
    }
    var top = niceMax(hi), base = 0;
    if (lo < 0) base = -niceMax(-lo);
    var span = top - base;
    if (span <= 0) return p.s;
    var y = function (val) { return p.y0 + p.ih - ((val - base) / span) * p.ih; };

    for (var g = 0; g <= 4; g++) {
      var gy = p.y0 + (g / 4) * p.ih;
      p.s.appendChild(svgEl('line', { x1: p.x0, y1: gy, x2: p.x1, y2: gy, 'class': 'gl' }));
      p.s.appendChild(text(p.x0 - 8, gy + 3, compact(top - (g / 4) * span), 'tk', 'end'));
    }

    function bar(idx, from, to, colour, label, lines, key) {
      var cx = p.x0 + slot * idx + slot / 2;
      var yTop = Math.min(y(from), y(to));
      var hgt = Math.max(2, Math.abs(y(from) - y(to)));
      var rect = svgEl('rect', { x: cx - bw / 2, y: yTop, width: bw, height: hgt,
        rx: 3, fill: colour });
      tip(rect, lines);
      if (key !== null) drillable(rect, panel.field, key);
      p.s.appendChild(rect);
      p.s.appendChild(valueLabel(cx, yTop - 6, label, 'vl'));
      return cx;
    }

    /* Start and end are totals and wear the neutral step; the movers wear the
       diverging pair, which is the one place in this product two hues encode
       direction rather than identity. */
    bar(0, base, panel.start, v(OTHER), fmt(panel.start),
        [panel.startLabel, recs(panel.start)], null);
    p.s.appendChild(valueLabel(p.x0 + slot * 0 + slot / 2, p.h - 24,
      truncate(panel.startLabel, 10), 'tk'));

    running = panel.start;
    for (i = 0; i < steps.length; i++) {
      var st = steps[i];
      var from = running, to = running + st.delta;
      var cxi = bar(i + 1, from, to,
        st.isOther ? v(OTHER) : (st.delta >= 0 ? v('--up') : v('--down')),
        (st.delta > 0 ? '+' : '') + fmt(st.delta),
        [st.label || '(not set)',
         (st.delta > 0 ? 'added ' : 'removed ') + recs(Math.abs(st.delta)),
         st.isOther ? 'folded from the smaller movers'
                    : fmt(st.from) + ' then ' + fmt(st.to)],
        st.isOther ? null : st.key);
      p.s.appendChild(valueLabel(cxi, p.h - 24, truncate(st.label || '(none)', 10), 'tk'));
      /* The connector is what makes the eye read this as one running total. */
      p.s.appendChild(svgEl('line', {
        x1: cxi + bw / 2, y1: y(to), x2: cxi + slot - bw / 2, y2: y(to),
        'class': 'gl', 'stroke-dasharray': '2 2' }));
      running = to;
    }

    bar(n - 1, base, panel.end, v(OTHER), fmt(panel.end),
        [panel.endLabel, recs(panel.end)], null);
    p.s.appendChild(valueLabel(p.x0 + slot * (n - 1) + slot / 2, p.h - 24,
      truncate(panel.endLabel, 10), 'tk'));

    p.s.appendChild(svgEl('line', { x1: p.x0, y1: y(base), x2: p.x1, y2: y(base),
      'class': 'bl' }));
    return p.s;
  }

  // ── grids ────────────────────────────────────────────────────────────────

  /**
   * A heatmap, used for both a crosstab and a week cycle. One hue, light to dark,
   * because the value being encoded is a magnitude and a rainbow would imply
   * categories that are not there.
   */
  function drawHeatmap(panel) {
    var grid = panel.grid || [];
    if (!grid.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No cells to draw.');
    }

    var rowLabels = panel.rowLabels || [];
    var colLabels = panel.colLabels || [];
    var isCycle = (panel.kind === 'cycle');
    if (isCycle) {
      colLabels = [];
      for (var hh = 0; hh < 24; hh++) colLabels.push(hh < 10 ? '0' + hh : String(hh));
    }

    var nRows = grid.length, nCols = grid[0].length;
    var padL = isCycle ? 40 : 122, padT = 30, padR = 10, padB = 34;
    var cellH = isCycle ? 22 : 26;
    var h = padT + nRows * cellH + padB;
    var s = svgRoot(W, h);
    var cw = (W - padL - padR) / nCols;
    var max = panel.maxCell || 1;

    var r, c;
    for (c = 0; c < nCols; c++) {
      var lbl = truncate(colLabels[c] === undefined ? '' : colLabels[c],
                         Math.max(3, Math.floor(cw / 6.4)));
      /* Every other hour on a cycle grid, or the labels collide at 24 columns. */
      if (!isCycle || c % 2 === 0) {
        s.appendChild(text(padL + cw * c + cw / 2, padT - 10, lbl, 'tk', 'middle'));
      }
    }

    for (r = 0; r < nRows; r++) {
      var ry = padT + r * cellH;
      s.appendChild(text(padL - 10, ry + cellH / 2 + 4,
        truncate(rowLabels[r] === undefined ? '' : rowLabels[r], isCycle ? 4 : 17),
        'ct', 'end'));
      for (c = 0; c < nCols; c++) {
        var val = grid[r][c];
        var t = max > 0 ? val / max : 0;
        var cell = svgEl('rect', {
          x: padL + cw * c + 1, y: ry + 1,
          width: Math.max(1, cw - 2), height: cellH - 2, rx: 3,
          fill: val === 0 ? v('--q0') : seqStep(t)
        });
        tip(cell, isCycle
          ? [rowLabels[r] + ' at ' + colLabels[c] + ':00 UTC',
             recs(val),
             pct(panel.total ? val / panel.total : 0) + ' of the week']
          : [panel.rowFieldLabel + ': ' + rowLabels[r],
             panel.colFieldLabel + ': ' + colLabels[c],
             recs(val),
             pct(panel.grand ? val / panel.grand : 0) + ' of the total']);
        s.appendChild(cell);
        /* A number in the cell only where the cell is big enough and the grid
           small enough that the numbers do not become the texture. */
        if (!isCycle && cw > 42 && val > 0 && nCols <= 8) {
          s.appendChild(text(padL + cw * c + cw / 2, ry + cellH / 2 + 4,
            compact(val), onSeq(t), 'middle'));
        }
      }
    }

    /* The ramp legend. A sequential scale is unreadable without one. */
    var lx = padL, ly = h - 16, lw = Math.min(180, (W - padL) * 0.4);
    for (var q = 0; q < SEQ.length; q++) {
      s.appendChild(svgEl('rect', { x: lx + (lw / SEQ.length) * q, y: ly - 9,
        width: lw / SEQ.length, height: 9, fill: v(SEQ[q]) }));
    }
    s.appendChild(text(lx - 6, ly, '0', 'tk', 'end'));
    s.appendChild(text(lx + lw + 6, ly, fmt(max), 'tk', 'start'));
    return s;
  }

  /**
   * A calendar heatmap: one square per day, weeks as columns.
   *
   * Position carries the date, so weekends line up as rows and a gap is visible as
   * a gap rather than as a dip that could be a low value.
   */
  function drawCalendar(panel) {
    var byDay = panel.byDay || {};
    var end = panel.endDay;
    if (!end) return svgRoot(W, 60);

    var cell = 13, gap = 3, padL = 34, padT = 26;
    var weeks = Math.floor((W - padL - 20) / (cell + gap));
    var days = weeks * 7;

    var endDays = isoToDays(end);
    /* Wind back to the Monday on or before the start, so every column is a whole
       week and the day-of-week rows are straight. */
    var startDays = endDays - days + 1;
    startDays -= mondayOffset(startDays);

    var h = padT + 7 * (cell + gap) + 34;
    var s = svgRoot(W, h);
    var max = panel.maxCell || 1;

    var dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (var d = 0; d < 7; d += 2) {
      s.appendChild(text(padL - 8, padT + d * (cell + gap) + cell - 2,
        dayNames[d], 'tk', 'end'));
    }

    var lastMonth = '';
    for (var w = 0; w < weeks; w++) {
      for (var dd = 0; dd < 7; dd++) {
        var abs = startDays + w * 7 + dd;
        if (abs > endDays) continue;
        var iso = daysToIso(abs);
        var val = byDay[iso] || 0;
        var t = max > 0 ? val / max : 0;
        var rect = svgEl('rect', {
          x: padL + w * (cell + gap), y: padT + dd * (cell + gap),
          width: cell, height: cell, rx: 2.5,
          fill: val === 0 ? v('--q0') : seqStep(t)
        });
        tip(rect, [iso, recs(val)]);
        s.appendChild(rect);

        if (dd === 0) {
          var mo = iso.substr(0, 7);
          if (mo !== lastMonth) {
            lastMonth = mo;
            s.appendChild(text(padL + w * (cell + gap), padT - 10,
              MONTH_ABBR[parseInt(iso.substr(5, 2), 10) - 1], 'tk', 'start'));
          }
        }
      }
    }

    var ly = h - 12, lx = padL;
    s.appendChild(text(lx, ly, 'less', 'tk', 'start'));
    for (var q = 0; q < SEQ.length; q++) {
      s.appendChild(svgEl('rect', { x: lx + 32 + q * (cell + 2), y: ly - 10,
        width: cell, height: cell, rx: 2.5, fill: v(SEQ[q]) }));
    }
    s.appendChild(text(lx + 32 + SEQ.length * (cell + 2) + 6, ly, 'more', 'tk', 'start'));
    s.appendChild(text(W - 4, ly, 'busiest day ' + fmt(max), 'tk', 'end'));
    return s;
  }

  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Day arithmetic, mirroring the server's. Same algorithm, so a date bucketed on
     the server and positioned in the browser cannot disagree. */
  function isoToDays(iso) {
    var y = parseInt(iso.substr(0, 4), 10);
    var m = parseInt(iso.substr(5, 2), 10);
    var d = parseInt(iso.substr(8, 2), 10);
    y -= (m <= 2) ? 1 : 0;
    var era = Math.floor(y / 400);
    var yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function daysToIso(z) {
    z += 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) -
                          Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp + (mp < 10 ? 3 : -9);
    y += (m <= 2) ? 1 : 0;
    return y + '-' + p2(m) + '-' + p2(d);
  }

  function mondayOffset(days) { return (((days + 3) % 7) + 7) % 7; }
  function p2(n) { return n < 10 ? '0' + n : String(n); }

  // ── distributions and relationships ──────────────────────────────────────

  /** A histogram over binned observations, with the quartile box beneath it. */
  function drawHistogramBins(panel) {
    var bins = panel.bins || [];
    if (!bins.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No values to bin.');
    }

    var p = plot(215, 44, 14, 18, 52);
    var max = 0, i;
    for (i = 0; i < bins.length; i++) if (bins[i].count > max) max = bins[i].count;
    max = niceMax(max);
    yAxis(p, max, 3);

    var slot = p.iw / bins.length;
    var span = panel.hi - panel.lo;
    for (i = 0; i < bins.length; i++) {
      var bh = bins[i].count === 0 ? 0 : Math.max(2, (bins[i].count / max) * p.ih);
      /* Histogram bars touch, with a 1px surface gap: the axis is continuous and a
         wide gap would imply the bins are categories. */
      var rect = svgEl('rect', { x: p.x0 + slot * i + 0.5, y: p.y1 - bh,
        width: Math.max(1, slot - 1), height: bh, rx: 2, fill: v('--c1') });
      tip(rect, [num(bins[i].from) + ' to ' + num(bins[i].to),
                 recs(bins[i].count),
                 pct(panel.n ? bins[i].count / panel.n : 0) + ' of the total']);
      p.s.appendChild(rect);
    }

    /* Median and quartiles marked on the axis, because the shape alone does not
       tell you where the middle is when the tail is long. */
    if (span > 0) {
      var mx = p.x0 + ((panel.median - panel.lo) / span) * p.iw;
      p.s.appendChild(svgEl('line', { x1: mx, y1: p.y0, x2: mx, y2: p.y1,
        stroke: v('--c4'), 'stroke-width': 2, 'stroke-dasharray': '4 3' }));
      p.s.appendChild(valueLabel(mx, p.y0 - 4, 'median ' + num(panel.median), 'vl'));
    }

    p.s.appendChild(text(p.x0, p.h - 26, num(panel.lo), 'tk', 'start'));
    p.s.appendChild(text(p.x1, p.h - 26, num(panel.hi), 'tk', 'end'));
    p.s.appendChild(text(p.x0, p.h - 8,
      bins.length + ' equal bins  ·  n = ' + fmt(panel.n) +
      '  ·  mean ' + num(panel.mean), 'tk', 'start'));
    return p.s;
  }

  function num(x) {
    if (x === null || x === undefined) return '0';
    var a = Math.abs(x);
    if (a >= 1000) return compact(x);
    if (a >= 10) return String(Math.round(x));
    return String(Math.round(x * 100) / 100);
  }

  /**
   * Box plots side by side.
   *
   * The one form that shows a difference in spread rather than a difference in
   * average. Whiskers end at the furthest real observation inside 1.5 IQR and
   * outliers are drawn individually, because those records are the ones worth
   * clicking through to.
   */
  function drawBox(panel) {
    var rows = panel.rows || [];
    if (!rows.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No group has enough records to summarise.');
    }

    var p = plot(60 + rows.length * 34, 130, 60, 18, 34);
    var lo = null, hi = null, i, j;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var mn = r.lo, mx = r.hi;
      for (j = 0; j < r.outliers.length; j++) {
        if (r.outliers[j] < mn) mn = r.outliers[j];
        if (r.outliers[j] > mx) mx = r.outliers[j];
      }
      if (lo === null || mn < lo) lo = mn;
      if (hi === null || mx > hi) hi = mx;
    }
    if (lo === hi) { hi = lo + 1; }
    var span = hi - lo;
    var x = function (val) { return p.x0 + ((val - lo) / span) * p.iw; };

    for (var g = 0; g <= 4; g++) {
      var gx = p.x0 + (g / 4) * p.iw;
      p.s.appendChild(svgEl('line', { x1: gx, y1: p.y0, x2: gx, y2: p.y1, 'class': 'gl' }));
      p.s.appendChild(text(gx, p.h - 14, num(lo + (g / 4) * span), 'tk', 'middle'));
    }

    var bh = 18;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cy = p.y0 + i * 34 + 16;
      p.s.appendChild(text(p.x0 - 10, cy + 4,
        truncate(row.label || '(not set)', 17), 'ct', 'end'));

      /* Whisker */
      p.s.appendChild(svgEl('line', { x1: x(row.lo), y1: cy, x2: x(row.hi), y2: cy,
        stroke: v('--ink-3'), 'stroke-width': 1.5 }));
      p.s.appendChild(svgEl('line', { x1: x(row.lo), y1: cy - 5, x2: x(row.lo), y2: cy + 5,
        stroke: v('--ink-3'), 'stroke-width': 1.5 }));
      p.s.appendChild(svgEl('line', { x1: x(row.hi), y1: cy - 5, x2: x(row.hi), y2: cy + 5,
        stroke: v('--ink-3'), 'stroke-width': 1.5 }));

      /* The box */
      var bx = x(row.q1), bw = Math.max(2, x(row.q3) - x(row.q1));
      var box = svgEl('rect', { x: bx, y: cy - bh / 2, width: bw, height: bh, rx: 3,
        fill: catColour(i), opacity: 0.85 });
      tip(box, [row.label || '(not set)',
                'median ' + num(row.median),
                'middle half ' + num(row.q1) + ' to ' + num(row.q3),
                'range ' + num(row.lo) + ' to ' + num(row.hi),
                recs(row.n) +
                (row.outliers.length ? ', ' + row.outliers.length + ' outliers' : '')]);
      drillable(box, panel.groupField, row.key);
      p.s.appendChild(box);

      /* Median: a surface-coloured rule inside the box, so it reads at any fill. */
      p.s.appendChild(svgEl('line', { x1: x(row.median), y1: cy - bh / 2,
        x2: x(row.median), y2: cy + bh / 2, stroke: v('--surface'), 'stroke-width': 2 }));

      for (j = 0; j < row.outliers.length; j++) {
        p.s.appendChild(svgEl('circle', { cx: x(row.outliers[j]), cy: cy, r: 2.6,
          fill: 'none', stroke: catColour(i), 'stroke-width': 1.4, opacity: 0.8 }));
      }
      p.s.appendChild(text(p.x1 + 8, cy + 4, fmt(row.n), 'vl', 'start'));
    }
    return p.s;
  }

  /** Two measures against each other, with quadrants at the medians. */
  function drawScatter(panel) {
    var pts = panel.points || [];
    if (!pts.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No records have both values set.');
    }

    var p = plot(250, 48, 16, 18, 56);
    var i;
    var xs = [], ys = [];
    for (i = 0; i < pts.length; i++) { xs.push(pts[i].x); ys.push(pts[i].y); }
    var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
    if (xMax === xMin) xMax = xMin + 1;
    if (yMax === yMin) yMax = yMin + 1;

    var X = function (val) { return p.x0 + ((val - xMin) / (xMax - xMin)) * p.iw; };
    var Y = function (val) { return p.y1 - ((val - yMin) / (yMax - yMin)) * p.ih; };

    for (var g = 0; g <= 4; g++) {
      var gy = p.y0 + (g / 4) * p.ih;
      p.s.appendChild(svgEl('line', { x1: p.x0, y1: gy, x2: p.x1, y2: gy, 'class': 'gl' }));
      p.s.appendChild(text(p.x0 - 8, gy + 3, num(yMax - (g / 4) * (yMax - yMin)), 'tk', 'end'));
      var gx = p.x0 + (g / 4) * p.iw;
      p.s.appendChild(text(gx, p.h - 30, num(xMin + (g / 4) * (xMax - xMin)), 'tk', 'middle'));
    }

    /* Reference quadrants at the medians. The brand kit specifies these and they
       are what turn a cloud into four statements you can name. */
    var sx = xs.slice().sort(function (a, b) { return a - b; });
    var sy = ys.slice().sort(function (a, b) { return a - b; });
    var mx = sx[Math.floor(sx.length / 2)], my = sy[Math.floor(sy.length / 2)];
    p.s.appendChild(svgEl('line', { x1: X(mx), y1: p.y0, x2: X(mx), y2: p.y1,
      stroke: v('--ink-3'), 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7 }));
    p.s.appendChild(svgEl('line', { x1: p.x0, y1: Y(my), x2: p.x1, y2: Y(my),
      stroke: v('--ink-3'), 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7 }));

    /* Colour by group where there is one, capped at the validated categorical set
       so a ninth series is never a generated hue. */
    var groups = {}, order = [];
    for (i = 0; i < pts.length; i++) {
      var k = pts[i].g || '';
      if (groups[k] === undefined) {
        groups[k] = order.length < CAT.length ? order.length : -1;
        order.push({ key: k, label: pts[i].gl || '(not set)' });
      }
    }
    var multi = panel.groupField && order.length > 1 && order.length <= CAT.length;

    var r = pts.length > 1200 ? 1.8 : pts.length > 400 ? 2.4 : 3.2;
    var op = pts.length > 1200 ? 0.4 : pts.length > 400 ? 0.55 : 0.75;
    for (i = 0; i < pts.length; i++) {
      var idx = multi ? groups[pts[i].g || ''] : 0;
      var dot = svgEl('circle', { cx: X(pts[i].x), cy: Y(pts[i].y), r: r,
        fill: idx < 0 ? v(OTHER) : catColour(idx), opacity: op });
      /* A per-point tooltip on four thousand points would be four thousand
         attributes. Only worth it where the marks are separable. */
      if (pts.length <= 400) {
        tip(dot, [(multi ? (pts[i].gl || '(not set)') : 'Record'),
                  panel.xFieldLabel + ': ' + num(pts[i].x),
                  panel.yFieldLabel + ': ' + num(pts[i].y)]);
      }
      p.s.appendChild(dot);
    }

    p.s.appendChild(text(p.x1, p.h - 30, panel.xFieldLabel, 'tk', 'end'));
    p.s.appendChild(text(p.x0 - 40, p.y0 - 6, panel.yFieldLabel, 'tk', 'start'));
    if (multi) {
      var items = [];
      for (i = 0; i < order.length; i++) {
        items.push({ label: order[i].label, colour: catColour(i) });
      }
      legendRow(p, items, p.h - 8);
    } else {
      p.s.appendChild(text(p.x0, p.h - 8, recs(pts.length) +
        (panel.corr === null ? '' : '  ·  r = ' + panel.corr), 'tk', 'start'));
    }
    return p.s;
  }

  // ── concentration, sequence, single values ───────────────────────────────

  /**
   * A real Pareto: ranked bars with the cumulative share as a line on the same
   * plot.
   *
   * This used to be aliased to the ranked bar renderer, which drew the bars and
   * dropped the cumulative line — the one element that makes it a Pareto rather
   * than a sorted bar chart.
   *
   * The cumulative axis is a percentage of a known total, not a second measure, so
   * this is not a dual-axis chart. That distinction is the reason it is allowed
   * here at all.
   */
  function drawPareto(panel) {
    var rows = panel.rows || [];
    if (!rows.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No values to rank.');
    }

    var p = plot(250, 46, 46, 20, 66);
    var max = niceMax(rows[0].count);
    yAxis(p, max, 4);

    var slot = p.iw / rows.length, bw = Math.min(46, slot * 0.66);
    var i, pts = [];

    for (i = 0; i < rows.length; i++) {
      var cx = p.x0 + slot * i + slot / 2;
      var bh = Math.max(2, (rows[i].count / max) * p.ih);
      /* The head that reaches 80% is the subject; the tail is context. */
      var inHead = (i < panel.eightyAt);
      var rect = svgEl('rect', { x: cx - bw / 2, y: p.y1 - bh, width: bw, height: bh,
        rx: 4, fill: inHead ? v('--c1') : v(OTHER) });
      tip(rect, [rows[i].label || '(not set)',
                 recs(rows[i].count),
                 pct(rows[i].count / panel.total) + ' of the total',
                 'cumulative ' + pct(rows[i].cumulative)]);
      drillable(rect, panel.field, rows[i].key);
      p.s.appendChild(rect);
      p.s.appendChild(valueLabel(cx, p.h - 48, truncate(rows[i].label || '(none)', 9), 'tk'));
      pts.push([cx, p.y1 - rows[i].cumulative * p.ih]);
    }

    p.s.appendChild(svgEl('path', { d: poly(pts), fill: 'none', stroke: v('--c4'),
      'stroke-width': 2, 'stroke-linejoin': 'round' }));
    for (i = 0; i < pts.length; i++) {
      p.s.appendChild(svgEl('circle', { cx: pts[i][0], cy: pts[i][1], r: 3,
        fill: v('--surface'), stroke: v('--c4'), 'stroke-width': 2 }));
    }

    /* The 80% rule, drawn, because that is the claim the form is making. */
    var y80 = p.y1 - 0.8 * p.ih;
    p.s.appendChild(svgEl('line', { x1: p.x0, y1: y80, x2: p.x1, y2: y80,
      stroke: v('--c4'), 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.8 }));
    p.s.appendChild(text(p.x1 + 4, y80 + 3, '80%', 'tk', 'start'));
    for (var g = 0; g <= 4; g++) {
      p.s.appendChild(text(p.x1 + 6, p.y0 + (g / 4) * p.ih + 3,
        (100 - g * 25) + '%', 'tk', 'start'));
    }

    p.s.appendChild(text(p.x0, p.h - 8,
      'Bars are counts on the left axis; the line is cumulative share on the right.',
      'tk', 'start'));
    return p.s;
  }

  /** A funnel. Width is the surviving share; the gap between stages is the drop. */
  function drawFunnel(panel) {
    var stages = panel.stages || [];
    if (!stages.length) {
      return emptyChart(svgRoot(W, 80), 80, 'No stages to draw.');
    }

    var rowH = 44, padT = 8, padL = 4;
    var h = padT + stages.length * rowH + 16;
    var s = svgRoot(W, h);
    var maxW = W - 150;

    for (var i = 0; i < stages.length; i++) {
      var st = stages[i];
      var y = padT + i * rowH;
      var w = Math.max(3, st.share * maxW);
      var cx = padL + (maxW - w) / 2 + 70;

      var t = 1 - (i / Math.max(1, stages.length - 1));
      var rect = svgEl('rect', { x: cx, y: y, width: w, height: rowH - 14, rx: 4,
        fill: seqStep(0.25 + 0.7 * t) });
      tip(rect, [st.label,
                 recs(st.count),
                 pct(st.share) + ' of the first stage',
                 i === 0 ? 'the entry stage'
                   : pct(st.stepShare) + ' carried through from ' + stages[i - 1].label]);
      drillable(rect, panel.field, st.key);
      s.appendChild(rect);

      s.appendChild(text(4, y + (rowH - 14) / 2 + 4,
        truncate(st.label, 11), 'ct', 'start'));
      s.appendChild(text(cx + w / 2, y + (rowH - 14) / 2 + 4,
        fmt(st.count), onSeq(0.25 + 0.7 * t), 'middle'));
      s.appendChild(text(W - 4, y + (rowH - 14) / 2 + 4, pct(st.share), 'vl', 'end'));

      /* The drop between stages is the number a funnel exists to show, so it is
         labelled on the gap rather than left to be inferred from two widths. */
      if (i > 0 && st.stepShare < 1) {
        s.appendChild(text(cx + w / 2, y - 3,
          '-' + pct(1 - st.stepShare), 'tk', 'middle'));
      }
    }
    return s;
  }

  /**
   * A radial gauge against a declared target, with the median marked as a notch.
   *
   * The commitment is a notch rather than a coloured arc segment: a coloured band
   * behind the value implies a good/bad judgement that nobody on this engagement
   * has defined, and inventing one would put an opinion on screen as if it were
   * data.
   */
  function drawGauge(panel) {
    var s = svgRoot(W, 176);
    var target = panel.target || 100;
    var val = Math.max(0, Math.min(target, panel.value || 0));
    var frac = target > 0 ? val / target : 0;

    var cx = W / 2, cy = 126, r = 82, thick = 20;
    var a0 = Math.PI, a1 = Math.PI * 2;

    s.appendChild(svgEl('path', { d: arc(cx, cy, r, r - thick, a0, a1),
      fill: v('--q0') }));
    if (frac > 0) {
      s.appendChild(svgEl('path', {
        d: arc(cx, cy, r, r - thick, a0, a0 + frac * (a1 - a0)),
        fill: v('--c1') }));
    }

    if (panel.median !== undefined && panel.median !== null && target > 0) {
      var mf = Math.max(0, Math.min(1, panel.median / target));
      var ma = a0 + mf * (a1 - a0);
      s.appendChild(svgEl('line', {
        x1: cx + (r - thick - 4) * Math.cos(ma), y1: cy + (r - thick - 4) * Math.sin(ma),
        x2: cx + (r + 4) * Math.cos(ma), y2: cy + (r + 4) * Math.sin(ma),
        stroke: v('--ink-1'), 'stroke-width': 2 }));
      s.appendChild(text(cx + (r + 14) * Math.cos(ma), cy + (r + 14) * Math.sin(ma) + 4,
        'median', 'tk', mf > 0.5 ? 'start' : 'end'));
    }

    s.appendChild(text(cx, cy - 8, num(panel.value), 'huge', 'middle'));
    s.appendChild(text(cx, cy + 14, 'mean of ' + fmt(panel.n) + ', target ' + target,
      'tk', 'middle'));
    s.appendChild(text(cx - r, cy + 16, '0', 'tk', 'middle'));
    s.appendChild(text(cx + r, cy + 16, String(target), 'tk', 'middle'));
    return s;
  }

  /**
   * A KPI tile. Where a comparison exists it is structurally required rather than
   * optional, because a number with nothing to compare it to is a fact and not an
   * indicator.
   */
  function drawKpi(panel) {
    var box = el('div', 'kpi');

    var top = el('div', 'kpi-l', panel.fieldLabel || '');
    box.appendChild(top);

    var valueRow = el('div', 'kpi-v');
    valueRow.appendChild(el('span', 'kpi-n',
      panel.unit === 'h' ? num(panel.value) + 'h' : compact(panel.value)));

    var d = panel.delta;
    if (d && d.change !== null) {
      var up = d.change > 0;
      var chip = el('span', 'kpi-d ' + (up ? 'up' : d.change < 0 ? 'down' : ''));
      chip.textContent = (up ? '▲ ' : d.change < 0 ? '▼ ' : '') +
        pct(Math.abs(d.change));
      chip.title = 'Against ' + fmt(d.previous) + ' in ' + d.previousLabel +
        (d.partial ? ', projected from ' + fmt(d.current) + ' so far this period.'
                   : '.');
      valueRow.appendChild(chip);
    }
    box.appendChild(valueRow);

    var sub = el('div', 'kpi-s');
    if (d && d.change !== null) {
      sub.textContent = (d.partial ? 'projected against ' : 'against ') +
        fmt(d.previous) + ' in ' + d.previousLabel;
    } else if (panel.median !== undefined && panel.median !== null) {
      sub.textContent = 'median ' + num(panel.median) +
        (panel.n ? '  ·  n = ' + fmt(panel.n) : '');
    } else {
      sub.textContent = panel.reason || '';
    }
    box.appendChild(sub);

    if (panel.capped) {
      box.appendChild(el('div', 'kpi-c', 'lower bound'));
    }
    return box;
  }

  /**
   * The report matrix.
   *
   * This is the artifact that separates a report from a dashboard, and the one
   * thing a grid of charts cannot substitute for. Five devices per row, each
   * derived: count, share, an in-cell bar, a sparkline of the same series the trend
   * above is drawn from, and variance against the last complete period.
   */
  function drawMatrix(panel) {
    var rows = panel.rows || [];
    var wrap = el('div', 'tbl-wrap');
    var t = el('table', 'tbl mx');

    var thead = el('thead'), hr = el('tr');
    hr.appendChild(el('th', 'l', panel.fieldLabel));
    hr.appendChild(el('th', 'n', 'Records'));
    hr.appendChild(el('th', 'n', 'Share'));
    hr.appendChild(el('th', 'l', ''));
    if (panel.periods) {
      hr.appendChild(el('th', 'l', panel.periods.length + ' ' + panel.grain + ' trend'));
      hr.appendChild(el('th', 'n', 'vs last'));
    }
    thead.appendChild(hr);
    t.appendChild(thead);

    var tb = el('tbody');
    var max = 0, i;
    for (i = 0; i < rows.length; i++) if (rows[i].count > max) max = rows[i].count;

    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var tr = el('tr');
      if (r.key !== '') {
        tr.setAttribute('data-drill-field', panel.field);
        tr.setAttribute('data-drill-key', r.key);
        tr.className = 'hit';
      }
      tr.appendChild(el('td', 'l', r.label));
      tr.appendChild(el('td', 'n', fmt(r.count)));
      tr.appendChild(el('td', 'n', pct(r.share)));

      /* In-cell bar: length against the largest row, which is the comparison the
         eye makes anyway and would otherwise have to be done by reading numbers. */
      var barCell = el('td', 'l');
      var bar = el('div', 'mx-bar');
      var fill = el('i');
      fill.style.width = (max > 0 ? (r.count / max) * 100 : 0) + '%';
      bar.appendChild(fill);
      barCell.appendChild(bar);
      tr.appendChild(barCell);

      if (panel.periods) {
        var sparkCell = el('td', 'l');
        if (r.spark) sparkCell.appendChild(sparkline(r.spark, panel.periods));
        tr.appendChild(sparkCell);

        var vc = el('td', 'n');
        if (r.change === null || r.change === undefined) {
          vc.textContent = '—';
        } else {
          vc.className = 'n ' + (r.change > 0 ? 'up' : r.change < 0 ? 'down' : '');
          vc.textContent = (r.change > 0 ? '+' : '') + pct(r.change);
          vc.title = (r.delta > 0 ? '+' : '') + fmt(r.delta) +
                     ' against the previous complete period';
        }
        tr.appendChild(vc);
      }
      tb.appendChild(tr);
    }
    t.appendChild(tb);

    var tf = el('tfoot'), fr = el('tr');
    fr.appendChild(el('td', 'l', 'Total'));
    fr.appendChild(el('td', 'n', fmt(panel.total)));
    fr.appendChild(el('td', 'n', '100%'));
    fr.appendChild(el('td', 'l', ''));
    if (panel.periods) {
      fr.appendChild(el('td', 'l', ''));
      fr.appendChild(el('td', 'n', ''));
    }
    tf.appendChild(fr);
    t.appendChild(tf);

    wrap.appendChild(t);
    return wrap;
  }

  /** An inline sparkline for a matrix row. No axis: it is a shape, not a reading. */
  function sparkline(counts, periods) {
    var w = 92, h = 22;
    var s = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, 'class': 'spark',
      preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    var max = Math.max.apply(null, counts) || 1;
    var pts = [], i;
    for (i = 0; i < counts.length; i++) {
      pts.push([(counts.length <= 1 ? w / 2 : (i / (counts.length - 1)) * w),
                h - 2 - (counts[i] / max) * (h - 4)]);
    }
    s.appendChild(svgEl('path', { d: poly(pts), fill: 'none', stroke: v('--c1'),
      'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    /* The open period is dashed here too, for the same reason as on the trend. */
    if (periods && periods.length === counts.length && periods[counts.length - 1].partial &&
        pts.length >= 2) {
      s.appendChild(svgEl('path', {
        d: poly([pts[pts.length - 2], pts[pts.length - 1]]),
        fill: 'none', stroke: v('--surface'), 'stroke-width': 2.5 }));
      s.appendChild(svgEl('path', {
        d: poly([pts[pts.length - 2], pts[pts.length - 1]]),
        fill: 'none', stroke: v('--c1'), 'stroke-width': 1.5,
        'stroke-dasharray': '2 2' }));
    }
    return s;
  }

  /**
   * What renders, and with what.
   *
   * The regression harness asserts this table covers every form CmdForm declares,
   * so a form added to the engine without a renderer fails the build rather than
   * falling back to a table in front of a client. Anything not here still degrades
   * to the labelled table view, which is the accessibility fallback every chart
   * needs regardless.
   *
   * Three entries used to be quiet lies and are called out because they are the
   * worst kind of charting bug -- the output looked finished and answered a
   * different question than the one in the title:
   *
   *   line_multi        drew the first series and discarded the rest
   *   pareto            drew the bars and dropped the cumulative line, which is
   *                     the only thing distinguishing a Pareto from sorted bars
   *   stat_tile_delta   drew the value and dropped the delta
   */
  var FORMS = {
    line: function (p) { return drawLine(p, false); },
    area: function (p) { return drawLine(p, true); },
    line_multi: drawLineMulti,
    stream: drawStream,
    small_multiples: drawSmallMultiples,
    column: drawColumn,
    ranked_bar: drawRankedBar,
    ranked_bar_top_n: drawRankedBar,
    pareto: drawPareto,
    stacked_proportion: function (p) { return drawStackedProportion(p, false); },
    stacked_ordinal: function (p) { return drawStackedProportion(p, true); },
    donut: function (p) { return drawDonut(p, false); },
    semi_donut: function (p) { return drawDonut(p, true); },
    heatmap: drawHeatmap,
    calendar_heatmap: drawCalendar,
    treemap: drawTreemap,
    scatter: drawScatter,
    /* Two histograms: the analysis panel arrives pre-binned over observations,
       while a dimension panel still carries grouped rows and bins them here. */
    histogram: function (p) {
      return (p.bins && p.bins.length) ? drawHistogramBins(p) : drawHistogram(p);
    },
    box: drawBox,
    gauge: drawGauge,
    waterfall: drawWaterfall,
    slope: drawSlope,
    bump: drawBump,
    matrix: drawMatrix,
    funnel: drawFunnel,
    /* A KPI tile is HTML rather than SVG -- there is no plot, so an SVG would be
       a text node in a viewBox. The dimension-panel scalar keeps the SVG form. */
    stat_tile: function (p) {
      return p.kind === 'kpi' ? drawKpi(p) : drawStatTile(p);
    },
    stat_tile_delta: drawKpi
  };

  // ── panel and page assembly ──────────────────────────────────────────────

  function severityClass(code) {
    return code === 'warn' ? 'cav warn' : 'cav';
  }

  function buildPanel(panel, payload) {
    var p = el('div', 'panel cp' + (panel.span === 2 ? ' span2' : ''));

    var head = el('div', 'cp-h');
    var left = el('div');
    left.appendChild(el('div', 'cp-t', panel.question));
    /* The reason the form was chosen is shown, not hidden. It is the product's
       actual argument and it is what makes the output reviewable. */
    left.appendChild(el('div', 'cp-s', panel.reason));
    head.appendChild(left);

    var meta = el('div', 'cp-m');
    meta.appendChild(el('span', 'form-tag', panel.form.replace(/_/g, ' ')));
    head.appendChild(meta);

    var body = el('div', 'cp-b');
    W = (panel.span === 2) ? W_SPAN2 : W_SINGLE;
    var draw = FORMS[panel.form];
    var chartNode;
    if (draw) {
      chartNode = draw(panel);
    } else {
      chartNode = el('div');
      chartNode.appendChild(el('div', 'cav', 'No renderer for "' + panel.form +
        '" yet, so the data is shown as a table.'));
      chartNode.appendChild(drawTable(panel));
    }
    body.appendChild(chartNode);

    /* The toggle is built after the chart, because it owns swapping the body
       between the two views and needs the node it is swapping out. */
    var toggle = viewToggle(panel, body, chartNode);
    if (toggle) meta.insertBefore(toggle, meta.firstChild);

    p.appendChild(head);
    p.appendChild(body);

    /* The analytics caption. The trend carries a fitted line and a projection, and
       the method behind them is stated on the panel rather than left to be assumed
       — twelve points and least squares is not a forecasting model, and a reader
       who thinks it is will over-trust the dashed line. */
    if (panel.annotation) {
      var a = panel.annotation;
      var cap = el('div', 'cp-an');
      cap.appendChild(el('span', 'an-k', a.direction));
      var words = 'about ' + (a.perPeriod > 0 ? '+' : '') + a.perPeriod +
                  ' per period on the fitted line. ' + a.method + '.';
      if (a.anomalies.length) {
        words += ' ' + a.anomalies.length + ' period' +
                 (a.anomalies.length === 1 ? '' : 's') + ' ringed as unusual.';
      }
      cap.appendChild(el('span', '', words));
      p.appendChild(cap);
    }

    // caveats, then the drill affordance
    if (panel.caveats && panel.caveats.length) {
      var cv = el('div', 'cavs');
      for (var i = 0; i < panel.caveats.length; i++) {
        cv.appendChild(el('div', severityClass(panel.caveats[i].severity),
          panel.caveats[i].text));
      }
      p.appendChild(cv);
    }

    if (panel.kind === 'dimension' && !payload.drill.atMax) {
      var foot = el('div', 'cp-f');
      var a = el('a', 'drill-link', 'Drill into ' + panel.fieldLabel.toLowerCase());
      a.href = drillUrl(payload, panel.field, null);
      a.setAttribute('data-field', panel.field);
      foot.appendChild(a);
      var lst = el('a', 'drill-link muted', 'Open records');
      lst.href = payload.subject.listUrl;
      foot.appendChild(lst);
      p.appendChild(foot);
    }
    return p;
  }

  function drillUrl(payload, field, key) {
    var path = payload.path.slice();
    var parts = [];
    for (var i = 0; i < path.length; i++) {
      parts.push(encodeURIComponent(path[i].field) + ':' + encodeURIComponent(path[i].key));
    }
    if (field !== null && field !== undefined) {
      parts.push(encodeURIComponent(field) + ':' + encodeURIComponent(key === null ? '' : key));
    }
    return 'cmd_dashboard.do?table=' + encodeURIComponent(payload.subject.table) +
           (parts.length ? '&path=' + encodeURIComponent(parts.join('|')) : '');
  }


  /**
   * The theme control. Present on both surfaces, because a viewer who switches on
   * one page and finds the other has forgotten is worse served than one who was
   * never offered the choice. cmd_theme.js resolves and persists; this only reflects
   * and sets.
   */
  function themeToggle() {
    var seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Theme');

    function paint() {
      var cur = window.CmdTheme ? window.CmdTheme.get() : 'light';
      var bs = seg.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) {
        bs[i].setAttribute('aria-selected',
          String(bs[i].getAttribute('data-t') === cur));
      }
    }

    ['light', 'dark'].forEach(function (t) {
      var b = el('button', null, t === 'light' ? 'Light' : 'Dark');
      b.type = 'button';
      b.setAttribute('data-t', t);
      b.addEventListener('click', function () {
        if (window.CmdTheme) window.CmdTheme.set(t);
        paint();
      });
      seg.appendChild(b);
    });
    paint();
    return seg;
  }

  /**
   * The time window slicer.
   *
   * It changes what the page measures, not just what it draws, so it is a
   * navigation and lives in the URL beside the drill path -- which means a
   * three-month view of a filtered slice is a shareable link, and the back button
   * reverses it.
   *
   * It also changes which forms the page can choose. A rank comparison over three
   * periods is a slope chart; over twelve, where series cross and recross, it is a
   * bump chart. That is the form engine doing its job on a different question, and
   * it is the clearest demonstration in the product that the chart follows the
   * data rather than a template.
   */
  function windowControl(payload) {
    var seg = el('div', 'seg sm');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Time window');

    var opts = payload.window.allowed;
    for (var i = 0; i < opts.length; i++) {
      var m = opts[i];
      var a = el('a', null, m + 'm');
      a.href = windowUrl(payload, m);
      a.setAttribute('aria-selected', String(m === payload.window.months));
      a.title = 'Rebuild this page over the last ' + m + ' months';
      seg.appendChild(a);
    }
    return seg;
  }

  function windowUrl(payload, months) {
    var parts = [];
    for (var i = 0; i < payload.path.length; i++) {
      parts.push(encodeURIComponent(payload.path[i].field) + ':' +
                 encodeURIComponent(payload.path[i].key));
    }
    return 'cmd_dashboard.do?table=' + encodeURIComponent(payload.subject.table) +
           (parts.length ? '&path=' + encodeURIComponent(parts.join('|')) : '') +
           '&months=' + months;
  }

  function buildHeader(payload) {
    var h = el('div', 'app-h');

    var left = el('div');
    var crumb = el('div', 'crumb');
    var root = el('a', '', payload.subject.label);
    root.href = 'cmd_dashboard.do?table=' + encodeURIComponent(payload.subject.table);
    crumb.appendChild(root);
    for (var i = 0; i < payload.path.length; i++) {
      crumb.appendChild(el('span', 'sep', '›'));
      var seg = payload.path[i];
      if (i === payload.path.length - 1) {
        crumb.appendChild(el('span', 'now', seg.fieldLabel + ': ' + seg.label));
      } else {
        var a = el('a', '', seg.fieldLabel + ': ' + seg.label);
        a.href = drillUrlUpTo(payload, i);
        crumb.appendChild(a);
      }
    }
    left.appendChild(crumb);
    left.appendChild(el('h1', 'd2', payload.subject.label + ' analysis'));

    var sub = el('div', 'sub');
    sub.appendChild(el('span', '', recs(payload.subject.rows)));
    sub.appendChild(el('span', 'dot', '·'));
    sub.appendChild(el('span', '', 'built in ' + payload.timingMs + 'ms'));
    left.appendChild(sub);
    h.appendChild(left);

    var right = el('div', 'app-h-r');
    right.appendChild(aclChip(payload.acl));
    if (payload.window) right.appendChild(windowControl(payload));
    right.appendChild(themeToggle());
    var lst = el('a', 'btn', 'Open record list');
    lst.href = payload.subject.listUrl;
    right.appendChild(lst);
    var back = el('a', 'btn', 'All subjects');
    back.href = 'cmd_catalog.do';
    right.appendChild(back);
    h.appendChild(right);
    return h;
  }

  function drillUrlUpTo(payload, idx) {
    var parts = [];
    for (var i = 0; i <= idx; i++) {
      parts.push(encodeURIComponent(payload.path[i].field) + ':' +
                 encodeURIComponent(payload.path[i].key));
    }
    return 'cmd_dashboard.do?table=' + encodeURIComponent(payload.subject.table) +
           '&path=' + encodeURIComponent(parts.join('|'));
  }

  /**
   * The ACL badge. This is the engagement's lead correctness claim made visible.
   * It is never absent: a viewer always knows whether the numbers in front of them
   * are the whole table or their own permitted slice of it.
   */
  function aclChip(acl) {
    var c = el('span', 'chip');
    if (acl.mode === 'VERIFIED') {
      c.className = 'chip ok';
      c.appendChild(el('span', 'dot'));
      c.appendChild(el('span', '', 'ACL verified'));
      c.title = 'The permission-checked count matches the raw aggregate, so nothing ' +
                'is hidden from you and nothing is being counted that you cannot open.';
    } else if (acl.mode === 'FILTERED') {
      c.className = 'chip warn';
      c.appendChild(el('span', 'dot'));
      c.appendChild(el('span', '', 'Filtered to your access'));
      c.title = recs(acl.delta) + ' exist that you cannot read. ' +
                (acl.delta === 1 ? 'It is' : 'They are') +
                ' excluded from every number on this page.';
    } else if (acl.mode === 'BOUNDED') {
      c.className = 'chip warn';
      c.appendChild(el('span', 'dot'));
      c.appendChild(el('span', '', 'Counts are a lower bound'));
    } else {
      c.className = 'chip crit';
      c.appendChild(el('span', 'dot'));
      c.appendChild(el('span', '', 'No access'));
    }
    return c;
  }

  function buildDrillPanel(payload) {
    if (!payload.drill.options || !payload.drill.options.length) return null;
    var p = el('div', 'panel pad drill-panel');
    p.appendChild(el('div', 'h3', 'Where you can go next'));
    p.appendChild(el('p', 'sm',
      'Offered only where the data supports a level. A rejected level shows why, ' +
      'because a dead-end click teaches you nothing and this does.'));

    var list = el('div', 'drill-list');
    var opts = payload.drill.options;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var row = el(o.offer ? 'a' : 'div', 'drill-row' + (o.offer ? '' : ' off'));
      if (o.offer) row.href = drillUrl(payload, o.field, null);

      var l = el('div', 'drill-l');
      l.appendChild(el('span', 'drill-n', o.label));
      l.appendChild(el('span', 'drill-r', o.reason));
      row.appendChild(l);

      var r = el('div', 'drill-meta');
      if (o.offer) {
        r.appendChild(el('span', 'chip ok sm', 'available'));
      } else {
        r.appendChild(el('span', 'chip sm', 'not offered'));
      }
      row.appendChild(r);
      list.appendChild(row);
    }
    p.appendChild(list);
    return p;
  }

  /**
   * The declared-hierarchy comparison, rendered.
   *
   * This panel is the argument for the whole product in one table: the dictionary
   * declares these parent-child hierarchies, and here is which of them survive
   * contact with the actual rows. On this instance `subcategory` is declared under
   * `category` and is populated on about half the records; `location` and
   * `caller_id` are declared and are effectively empty.
   */
  function buildDeclaredPanel(payload) {
    if (!payload.declared || !payload.declared.length) return null;
    var p = el('div', 'panel pad span2');
    p.appendChild(el('div', 'h3', 'What the schema claims, against what the data holds'));
    p.appendChild(el('p', 'sm',
      'The dictionary declares these as parent-child hierarchies. A declaration ' +
      'records that somebody intended one, not that the rows contain one, so each ' +
      'is measured against your own permitted records before it is offered.'));

    var wrap = el('div', 'tbl-wrap');
    var t = el('table', 'tbl');
    var head = el('tr');
    head.appendChild(el('th', 'l', 'Declared level'));
    head.appendChild(el('th', 'l', 'Under'));
    head.appendChild(el('th', 'n', 'Populated'));
    head.appendChild(el('th', 'n', 'Values'));
    head.appendChild(el('th', 'l', 'Verdict'));
    var thead = el('thead'); thead.appendChild(head); t.appendChild(thead);

    var tb = el('tbody');
    for (var i = 0; i < payload.declared.length; i++) {
      var d = payload.declared[i];
      var tr = el('tr');
      tr.appendChild(el('td', 'l', d.label));
      tr.appendChild(el('td', 'l', d.declaredParentLabel || d.declaredParent || ''));
      tr.appendChild(el('td', 'n', d.fill === null ? '-' : pct(d.fill)));
      tr.appendChild(el('td', 'n', d.distinct === null ? '-' : fmt(d.distinct)));
      var vd = el('td', 'l');
      var chip = el('span', 'chip sm ' + (d.offer ? 'ok' : ''),
        d.offer ? 'usable' : 'rejected');
      vd.appendChild(chip);
      vd.appendChild(el('span', 'vr', d.reason));
      tr.appendChild(vd);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    p.appendChild(wrap);
    return p;
  }

  function gradients() {
    var s = svgEl('svg', { width: 0, height: 0, 'aria-hidden': 'true',
      style: 'position:absolute' });
    var defs = svgEl('defs');
    var g = svgEl('linearGradient', { id: 'cmdArea', x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl('stop', { offset: '0%', 'stop-color': v('--c1'),
      'stop-opacity': v('--fill-area') }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': v('--c1'),
      'stop-opacity': '0' }));
    defs.appendChild(g);
    s.appendChild(defs);
    return s;
  }

  // ── the interaction layer ────────────────────────────────────────────────

  /**
   * One tooltip for the whole page, positioned on hover.
   *
   * Delegated at the mount rather than bound per mark: a dense page carries a few
   * thousand marks and that many listeners is a measurable cost on a 1.2s
   * first-paint budget for no benefit. Marks carry their report in `data-tip` and
   * this reads it.
   *
   * Focus is handled alongside hover, so the same report is reachable from the
   * keyboard. That is why tip() sets tabindex: a tooltip only a mouse can reach is
   * a tooltip half the requirement.
   */
  function tooltipLayer(mount) {
    var box = el('div', 'cmd-tip');
    box.setAttribute('role', 'tooltip');
    box.setAttribute('aria-hidden', 'true');
    document.body.appendChild(box);

    var shown = null;

    function render(target) {
      var raw = target.getAttribute('data-tip');
      if (!raw) return;
      box.innerHTML = '';
      var lines = raw.split('\n');
      for (var i = 0; i < lines.length; i++) {
        box.appendChild(el('div', i === 0 ? 'tip-h' : 'tip-r', lines[i]));
      }
      box.className = 'cmd-tip on';
      box.setAttribute('aria-hidden', 'false');
      shown = target;
      place(target);
    }

    function place(target) {
      var r = target.getBoundingClientRect();
      var bw = box.offsetWidth, bh = box.offsetHeight;
      var sx = window.pageXOffset || document.documentElement.scrollLeft;
      var sy = window.pageYOffset || document.documentElement.scrollTop;

      var left = r.left + sx + r.width / 2 - bw / 2;
      var top = r.top + sy - bh - 10;
      /* Flip below when there is no room above, and clamp inside the viewport, so
         a mark near an edge does not put its own report off screen. */
      if (r.top - bh - 10 < 0) top = r.bottom + sy + 10;
      var maxLeft = (document.documentElement.clientWidth || 0) + sx - bw - 8;
      if (left > maxLeft) left = maxLeft;
      if (left < sx + 8) left = sx + 8;

      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
    }

    function hide() {
      box.className = 'cmd-tip';
      box.setAttribute('aria-hidden', 'true');
      shown = null;
    }

    function nearest(node) {
      while (node && node !== mount) {
        if (node.getAttribute && node.getAttribute('data-tip')) return node;
        node = node.parentNode;
      }
      return null;
    }

    mount.addEventListener('mouseover', function (e) {
      var t = nearest(e.target);
      if (t && t !== shown) render(t);
    });
    mount.addEventListener('mouseout', function (e) {
      var t = nearest(e.target);
      if (t && t === shown) hide();
    });
    mount.addEventListener('focusin', function (e) {
      var t = nearest(e.target);
      if (t) render(t);
    });
    mount.addEventListener('focusout', hide);
    window.addEventListener('scroll', function () { if (shown) place(shown); });
    document.addEventListener('keydown', function (e) {
      if (e.keyCode === 27) hide();
    });
  }

  /**
   * Cross-highlighting, and the honest limit of it.
   *
   * Power BI cross-filters: click a bar and every other visual re-aggregates to
   * that slice. We deliberately do not do that in the browser, and the reason is
   * the engagement's central rule rather than an implementation shortcut.
   * Re-aggregating client side would mean shipping the records to the page, and
   * every number in this product is aggregated server side specifically so that
   * rows the viewer cannot read never enter the response. Trading that away to
   * avoid a page load would give up the one correctness property the whole product
   * is built on.
   *
   * So a click does two things instead. It cross-highlights immediately, in the
   * page, with no request: every mark keyed to the same value stays lit and the
   * rest recede, which is the read-a-slice-across-panels affordance people
   * actually use it for. And it offers the real filter as an explicit action,
   * which is a drill: the server rebuilds the payload for that slice, ACL-checked,
   * and the result is shareable and reversible because it lives in the URL.
   */
  function highlightLayer(mount, payload) {
    var active = null;
    var bar = null;

    function marks() {
      return mount.querySelectorAll('[data-drill-field]');
    }

    function paint() {
      var all = marks(), i;
      for (i = 0; i < all.length; i++) {
        var f = all[i].getAttribute('data-drill-field');
        var k = all[i].getAttribute('data-drill-key');
        var cls = all[i].getAttribute('class') || '';
        cls = cls.replace(/ ?(dim|lit)\b/g, '');
        if (active) {
          /* Only panels that actually carry the selected field respond. A panel
             about a different dimension has no opinion about this selection and
             dimming it would imply one. */
          if (f === active.field) cls += (k === active.key) ? ' lit' : ' dim';
        }
        all[i].setAttribute('class', cls);
      }
      chip();
    }

    function chip() {
      if (bar) { bar.parentNode.removeChild(bar); bar = null; }
      if (!active) return;

      bar = el('div', 'sel-bar');
      var label = el('span', 'sel-l');
      label.textContent = active.fieldLabel + ': ' + active.label;
      bar.appendChild(label);

      var go = el('a', 'btn sm');
      go.textContent = 'Filter the whole page';
      go.href = drillUrl(payload, active.field, active.key);
      go.title = 'Rebuilds every panel for this slice on the server, ' +
                 'permission-checked, with the filter in the URL so it can be ' +
                 'shared and stepped back out of.';
      bar.appendChild(go);

      var clear = el('button', 'btn sm ghost', 'Clear selection');
      clear.type = 'button';
      clear.addEventListener('click', function () { active = null; paint(); });
      bar.appendChild(clear);

      var note = el('span', 'sel-n',
        'Highlighted across this page. Other panels keep their own totals until ' +
        'you filter.');
      bar.appendChild(note);

      mount.insertBefore(bar, mount.firstChild.nextSibling);
    }

    function labelOf(node) {
      var raw = node.getAttribute('data-tip');
      return raw ? raw.split('\n')[0] : node.getAttribute('data-drill-key');
    }

    mount.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== mount) {
        if (node.getAttribute && node.getAttribute('data-drill-field')) break;
        node = node.parentNode;
      }
      if (!node || node === mount) return;

      var field = node.getAttribute('data-drill-field');
      var key = node.getAttribute('data-drill-key');
      if (active && active.field === field && active.key === key) {
        active = null;
      } else {
        active = { field: field, key: key, label: labelOf(node),
                   fieldLabel: fieldLabelOf(payload, field) };
      }
      paint();
    });
  }

  function fieldLabelOf(payload, field) {
    for (var i = 0; i < payload.panels.length; i++) {
      var p = payload.panels[i];
      if (p.field === field && p.fieldLabel) return p.fieldLabel;
      if (p.groupField === field && p.groupFieldLabel) return p.groupFieldLabel;
    }
    if (payload.matrix && payload.matrix.field === field) return payload.matrix.fieldLabel;
    return field;
  }

  /**
   * The filter bar: which slice of the subject is on screen, and how to get out.
   *
   * Every step of the drill path is a removable chip rather than only a
   * breadcrumb, because the path is a set of filters and the thing you most often
   * want is to drop one from the middle without losing the rest.
   */
  function filterBar(payload) {
    if (!payload.path || !payload.path.length) return null;

    var bar = el('div', 'filter-bar');
    bar.appendChild(el('span', 'fb-l', 'Filtered to'));

    for (var i = 0; i < payload.path.length; i++) {
      var seg = payload.path[i];
      var chip = el('span', 'fb-chip');
      chip.appendChild(el('span', 'fb-f', seg.fieldLabel));
      chip.appendChild(el('span', 'fb-v', seg.label));

      var drop = el('a', 'fb-x');
      drop.textContent = '×';
      drop.href = dropFromPath(payload, i);
      drop.title = 'Remove this filter and keep the others';
      drop.setAttribute('aria-label', 'Remove filter ' + seg.fieldLabel);
      chip.appendChild(drop);
      bar.appendChild(chip);
    }

    var all = el('a', 'fb-clear', 'Clear all');
    all.href = 'cmd_dashboard.do?table=' + encodeURIComponent(payload.subject.table);
    bar.appendChild(all);
    return bar;
  }

  function dropFromPath(payload, idx) {
    var parts = [];
    for (var i = 0; i < payload.path.length; i++) {
      if (i === idx) continue;
      parts.push(encodeURIComponent(payload.path[i].field) + ':' +
                 encodeURIComponent(payload.path[i].key));
    }
    return 'cmd_dashboard.do?table=' + encodeURIComponent(payload.subject.table) +
           (parts.length ? '&path=' + encodeURIComponent(parts.join('|')) : '');
  }

  /**
   * The chart/table toggle.
   *
   * Present on every panel that has rows behind it. This is the accessibility
   * fallback the dataviz rules require, and it is also the thing an analyst asks
   * for within about a minute of seeing any chart: the numbers.
   */
  function viewToggle(panel, body, chartNode) {
    if (!hasTabularForm(panel)) return null;

    var seg = el('div', 'seg sm');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'View as');
    var tableNode = null;

    function show(which) {
      body.innerHTML = '';
      if (which === 'table') {
        if (!tableNode) tableNode = tabulate(panel);
        body.appendChild(tableNode);
      } else {
        body.appendChild(chartNode);
      }
      var bs = seg.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) {
        bs[i].setAttribute('aria-selected',
          String(bs[i].getAttribute('data-v') === which));
      }
    }

    [['chart', 'Chart'], ['table', 'Table']].forEach(function (pair) {
      var b = el('button', null, pair[1]);
      b.type = 'button';
      b.setAttribute('data-v', pair[0]);
      b.addEventListener('click', function () { show(pair[0]); });
      seg.appendChild(b);
    });
    show('chart');
    return seg;
  }

  function hasTabularForm(panel) {
    if (panel.kind === 'kpi' || panel.form === 'matrix') return false;
    return !!(panel.rows || panel.points || panel.series || panel.stages ||
              panel.bins || panel.grid || panel.steps);
  }

  /**
   * The numbers behind any panel, whatever its form.
   *
   * One function rather than a table renderer per form, because the fallback has to
   * exist for every panel and a per-form implementation is a per-form omission
   * waiting to happen.
   */
  function tabulate(panel) {
    var wrap = el('div', 'tbl-wrap');
    var t = el('table', 'tbl');
    var head = el('tr'), tb = el('tbody');
    var i, j;

    function th(label, cls) { head.appendChild(el('th', cls || 'l', label)); }
    function row(cells) {
      var tr = el('tr');
      for (var c = 0; c < cells.length; c++) {
        tr.appendChild(el('td', cells[c].n ? 'n' : 'l', cells[c].v));
      }
      tb.appendChild(tr);
    }

    if (panel.points) {                       /* scatter */
      th(panel.xFieldLabel, 'n'); th(panel.yFieldLabel, 'n');
      if (panel.groupField) th(panel.groupFieldLabel);
      var cap = Math.min(panel.points.length, 250);
      for (i = 0; i < cap; i++) {
        var cells = [{ v: num(panel.points[i].x), n: true },
                     { v: num(panel.points[i].y), n: true }];
        if (panel.groupField) cells.push({ v: panel.points[i].gl || '(not set)' });
        row(cells);
      }
      if (panel.points.length > cap) {
        row([{ v: 'and ' + fmt(panel.points.length - cap) + ' more rows' }]);
      }

    } else if (panel.bins) {                  /* histogram */
      th('Range'); th('Records', 'n'); th('Share', 'n');
      for (i = 0; i < panel.bins.length; i++) {
        row([{ v: num(panel.bins[i].from) + ' to ' + num(panel.bins[i].to) },
             { v: fmt(panel.bins[i].count), n: true },
             { v: pct(panel.n ? panel.bins[i].count / panel.n : 0), n: true }]);
      }

    } else if (panel.stages) {                /* funnel */
      th('Stage'); th('Records', 'n'); th('Of first', 'n'); th('Carried through', 'n');
      for (i = 0; i < panel.stages.length; i++) {
        row([{ v: panel.stages[i].label },
             { v: fmt(panel.stages[i].count), n: true },
             { v: pct(panel.stages[i].share), n: true },
             { v: i === 0 ? '—' : pct(panel.stages[i].stepShare), n: true }]);
      }

    } else if (panel.steps) {                 /* waterfall */
      th(panel.fieldLabel); th('Before', 'n'); th('After', 'n'); th('Change', 'n');
      for (i = 0; i < panel.steps.length; i++) {
        var st = panel.steps[i];
        row([{ v: st.label || '(not set)' },
             { v: st.from === undefined ? '—' : fmt(st.from), n: true },
             { v: st.to === undefined ? '—' : fmt(st.to), n: true },
             { v: (st.delta > 0 ? '+' : '') + fmt(st.delta), n: true }]);
      }

    } else if (panel.grid && panel.rowLabels) {   /* heatmap or cycle */
      th('');
      var cols = panel.colLabels;
      if (!cols) { cols = []; for (i = 0; i < 24; i++) cols.push(i + ':00'); }
      for (j = 0; j < cols.length; j++) th(cols[j], 'n');
      for (i = 0; i < panel.grid.length; i++) {
        var line = [{ v: panel.rowLabels[i] }];
        for (j = 0; j < panel.grid[i].length; j++) {
          line.push({ v: fmt(panel.grid[i][j]), n: true });
        }
        row(line);
      }

    } else if (panel.series) {                /* any time-by-category form */
      th(panel.fieldLabel);
      for (j = 0; j < panel.periods.length; j++) th(panel.periods[j].label, 'n');
      th('Total', 'n');
      var all = panel.series.slice();
      if (panel.other) all.push(panel.other);
      for (i = 0; i < all.length; i++) {
        var r2 = [{ v: all[i].label || '(not set)' }];
        for (j = 0; j < panel.periods.length; j++) {
          r2.push({ v: fmt(all[i].counts[j] || 0), n: true });
        }
        r2.push({ v: fmt(all[i].total), n: true });
        row(r2);
      }

    } else if (panel.rows && panel.rows.length && panel.rows[0].median !== undefined) {
      th(panel.groupFieldLabel || panel.fieldLabel);
      th('n', 'n'); th('Min', 'n'); th('Q1', 'n'); th('Median', 'n');
      th('Q3', 'n'); th('Max', 'n');
      for (i = 0; i < panel.rows.length; i++) {
        var b = panel.rows[i];
        row([{ v: b.label || '(not set)' }, { v: fmt(b.n), n: true },
             { v: num(b.lo), n: true }, { v: num(b.q1), n: true },
             { v: num(b.median), n: true }, { v: num(b.q3), n: true },
             { v: num(b.hi), n: true }]);
      }

    } else if (panel.rows && panel.rows.length && panel.rows[0].from !== undefined) {
      th(panel.fieldLabel); th('Before', 'n'); th('After', 'n'); th('Change', 'n');
      for (i = 0; i < panel.rows.length; i++) {
        var sr = panel.rows[i];
        row([{ v: sr.label || '(not set)' }, { v: fmt(sr.from), n: true },
             { v: fmt(sr.to), n: true },
             { v: (sr.to - sr.from > 0 ? '+' : '') + fmt(sr.to - sr.from), n: true }]);
      }

    } else if (panel.rows && panel.rows.length && panel.rows[0].cumulative !== undefined) {
      th(panel.fieldLabel); th('Records', 'n'); th('Share', 'n'); th('Cumulative', 'n');
      for (i = 0; i < panel.rows.length; i++) {
        row([{ v: panel.rows[i].label || '(not set)' },
             { v: fmt(panel.rows[i].count), n: true },
             { v: pct(panel.rows[i].count / panel.total), n: true },
             { v: pct(panel.rows[i].cumulative), n: true }]);
      }

    } else if (panel.points === undefined && panel.rows) {   /* grouped rows */
      return drawTable(panel);

    } else {
      return el('div', 'cav', 'No tabular view for this panel.');
    }

    var thead = el('thead'); thead.appendChild(head);
    t.appendChild(thead); t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  /** The KPI row. */
  function buildKpiRow(kpis) {
    var row = el('div', 'kpi-row');
    for (var i = 0; i < kpis.length; i++) {
      var draw = FORMS[kpis[i].form];
      row.appendChild(draw ? draw(kpis[i]) : drawKpi(kpis[i]));
    }
    return row;
  }

  // ── entry ────────────────────────────────────────────────────────────────

  function renderDashboard(payload, mount) {
    mount.innerHTML = '';
    mount.appendChild(gradients());

    if (payload.error) {
      var e = el('div', 'panel pad');
      e.appendChild(el('div', 'h3', 'Cannot show this subject'));
      e.appendChild(el('p', 'sm', payload.error));
      var back = el('a', 'btn', 'All subjects'); back.href = 'cmd_catalog.do';
      e.appendChild(back);
      mount.appendChild(e);
      return;
    }

    mount.appendChild(buildHeader(payload));

    /* Which slice is on screen, and how to step out of it. Above everything,
       because a page showing a filtered subset while looking like the whole table
       is the fastest way to have someone act on the wrong number. */
    var fb = filterBar(payload);
    if (fb) mount.appendChild(fb);

    /* The headline numbers, before any chart. A leader reads these and stops; the
       charts exist to answer the question these provoke. */
    if (payload.kpis && payload.kpis.length) {
      mount.appendChild(buildKpiRow(payload.kpis));
    }

    if (payload.notes && payload.notes.length) {
      for (var n = 0; n < payload.notes.length; n++) {
        mount.appendChild(el('div', 'note', payload.notes[n]));
      }
    }

    var grid = el('div', 'grid-panels');
    for (var i = 0; i < payload.panels.length; i++) {
      grid.appendChild(buildPanel(payload.panels[i], payload));
    }
    if (payload.matrix) grid.appendChild(buildPanel(payload.matrix, payload));
    var dp = buildDrillPanel(payload);
    if (dp) grid.appendChild(dp);
    var decl = buildDeclaredPanel(payload);
    if (decl) grid.appendChild(decl);
    mount.appendChild(grid);

    /* Behaviour is attached after the DOM exists, and both handlers are delegated
       at the mount, so this is two listeners for a page carrying a few thousand
       marks rather than a few thousand listeners. */
    tooltipLayer(mount);
    highlightLayer(mount, payload);
  }

  function renderCatalog(payload, mount) {
    mount.innerHTML = '';

    var h = el('div', 'app-h');
    var left = el('div');
    left.appendChild(el('div', 'crumb', 'Analytics'));
    left.appendChild(el('h1', 'd2', 'Dashboards'));
    var sub = el('div', 'sub');
    sub.appendChild(el('span', '', payload.stats.offered + ' subjects you can open'));
    sub.appendChild(el('span', 'dot', '\u00b7'));
    sub.appendChild(el('span', '', 'as ' + payload.stats.user));
    left.appendChild(sub);
    h.appendChild(left);
    var right = el('div', 'app-h-r');
    right.appendChild(themeToggle());
    h.appendChild(right);
    mount.appendChild(h);

    if (!payload.cards || !payload.cards.length) {
      mount.appendChild(el('div', 'note',
        'There are no subjects with enough readable records to chart.'));
      return;
    }

    /* Controls. Everything filters client side over the payload already in the
       page, so typing costs nothing and there is no request per keystroke. With a
       dozen subjects that is enough; past a few hundred this becomes a server
       concern and the note below says so. */
    var bar = el('div', 'cat-bar');

    var fieldWrap = el('div', 'field');
    var input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search subjects, tables or fields';
    input.setAttribute('aria-label', 'Search subjects');
    fieldWrap.appendChild(input);
    bar.appendChild(fieldWrap);

    var areas = [];
    for (var a = 0; a < payload.areas.length; a++) areas.push(payload.areas[a].area);

    var active = null;
    var filters = el('div', 'filters');
    var allChip = el('button', 'fchip', 'All');
    allChip.type = 'button';
    allChip.setAttribute('aria-pressed', 'true');
    filters.appendChild(allChip);
    var chips = [allChip];
    areas.forEach(function (name) {
      var c = el('button', 'fchip', name);
      c.type = 'button';
      c.setAttribute('aria-pressed', 'false');
      c.setAttribute('data-area', name);
      filters.appendChild(c);
      chips.push(c);
    });
    bar.appendChild(filters);

    var count = el('div', 'cat-count');
    bar.appendChild(count);
    mount.appendChild(bar);

    var host = el('div');
    mount.appendChild(host);

    function matches(card, q) {
      if (active && card.area !== active) return false;
      if (!q) return true;
      var hay = (card.label + ' ' + card.table + ' ' + card.area + ' ' +
                 (card.leadDimension || '') + ' ' +
                 (card.preview ? card.preview.fieldLabel : '')).toLowerCase();
      return hay.indexOf(q) > -1;
    }

    function draw() {
      var q = input.value.toLowerCase().replace(/^\s+|\s+$/g, '');
      host.innerHTML = '';
      var shown = 0;

      for (var i = 0; i < payload.areas.length; i++) {
        var area = payload.areas[i];
        var keep = [];
        for (var j = 0; j < area.cards.length; j++) {
          if (matches(area.cards[j], q)) keep.push(area.cards[j]);
        }
        if (!keep.length) continue;

        var head = el('div', 'area-h');
        head.appendChild(el('span', 'area-n', area.area));
        head.appendChild(el('span', 'area-c', keep.length + ' subject' +
          (keep.length === 1 ? '' : 's')));
        host.appendChild(head);

        var cards = el('div', 'cards');
        for (var k = 0; k < keep.length; k++) cards.appendChild(catalogCard(keep[k]));
        host.appendChild(cards);
        shown += keep.length;
      }

      if (!shown) {
        host.appendChild(el('div', 'panel empty',
          'Nothing matches "' + input.value + '".'));
      }
      count.textContent = shown + ' of ' + payload.cards.length + ' shown';
    }

    input.addEventListener('input', draw);
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        active = c.getAttribute('data-area') || null;
        chips.forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === c));
        });
        draw();
      });
    });
    draw();

    var s = el('div', 'note');
    s.textContent = 'Considered ' + payload.stats.considered + ' subjects. ' +
      payload.stats.denied + ' are hidden because you cannot read them, ' +
      payload.stats.tooSmall + ' have too few records to chart. The list is derived ' +
      'from where reporting demand already is on this instance, not from a ' +
      'configured list, so it changes as the instance does.';
    mount.appendChild(s);
  }

  /**
   * One catalog card.
   *
   * Carries a real distribution rather than a decorative one: the top three values
   * of the subject's leading dimension, measured through the same ACL-checked path
   * as the dashboards. That is what makes the grid scannable, and it is why there is
   * no sparkline here. A chart drawn from nothing would look better and mean less.
   */
  function catalogCard(k) {
    var card = el('a', 'card');
    card.href = k.url;

    var head = el('div', 'card-h');
    head.appendChild(el('div', 'card-n', k.label));
    head.appendChild(el('div', 'card-sub', k.table));
    card.appendChild(head);

    /* Two stats, not three. A "reports" count used to sit here, sourced from an
       ACL-unchecked GlideAggregate over sys_report -- which carries private,
       owner-scoped rows -- so it could show a viewer a number that included
       reports they cannot open. It never reaches the payload now; see
       CmdCatalog.build(). Everything still shown here is a checked number. */
    var stats = el('div', 'card-stats');
    stats.appendChild(stat(k.capped ? compact(k.rows) + '+' : compact(k.rows), 'records'));
    stats.appendChild(stat(String(k.dimensions), 'dimensions'));
    card.appendChild(stats);

    if (k.preview && k.preview.top.length) {
      var prev = el('div', 'card-prev');
      prev.appendChild(el('div', 'card-prev-l',
        'by ' + k.preview.fieldLabel.toLowerCase() + ', ' +
        k.preview.distinct + ' values'));

      var bar = el('div', 'prev-bar');
      for (var i = 0; i < k.preview.top.length; i++) {
        var seg = el('i');
        seg.style.width = Math.max(2, k.preview.top[i].share * 100) + '%';
        seg.style.background = catColour(i);
        bar.appendChild(seg);
      }
      if (k.preview.restShare > 0.005) {
        var rest = el('i');
        rest.style.width = (k.preview.restShare * 100) + '%';
        rest.style.background = v(OTHER);
        bar.appendChild(rest);
      }
      prev.appendChild(bar);

      var keys = el('div', 'prev-keys');
      for (var j = 0; j < k.preview.top.length; j++) {
        var pk = el('span', 'pk');
        var sw = el('i');
        sw.style.background = catColour(j);
        pk.appendChild(sw);
        pk.appendChild(el('span', '',
          truncate(k.preview.top[j].label, 16) + '  ' + pct(k.preview.top[j].share)));
        keys.appendChild(pk);
      }
      prev.appendChild(keys);
      card.appendChild(prev);
    }

    var f = el('div', 'card-f');
    f.appendChild(el('span', '', k.leadDate ? 'trend on ' + k.leadDate.toLowerCase() : 'no date field'));
    f.appendChild(el('span', 'card-go', 'Open \u2192'));
    card.appendChild(f);
    return card;
  }

  function stat(value, label) {
    var d = el('div', 'cs');
    d.appendChild(el('div', 'cs-v', value));
    d.appendChild(el('div', 'cs-l', label));
    return d;
  }

  window.CmdRender = {
    dashboard: renderDashboard,
    catalog: renderCatalog,
    forms: FORMS
  };

  /**
   * Decodes the payload the page embedded.
   *
   * It arrives base64-encoded in a data attribute rather than as inline JSON,
   * because Jelly evaluates ${...} and $[...] inside both attributes and text, and
   * the payload carries field labels and record values from the instance, any of
   * which could contain those sequences. Base64 has no $, no braces and no quotes,
   * so it cannot be evaluated, cannot break the XML and cannot be mangled by HTML
   * escaping.
   *
   * atob returns bytes, not characters, so a label containing anything outside
   * ASCII would arrive mojibake without this UTF-8 step.
   */
  function decodePayload() {
    var holder = document.getElementById('cmd-data');
    if (!holder) return null;
    var b64 = holder.getAttribute('data-b64');
    if (!b64) return null;

    var bin = atob(b64);
    var json;
    try {
      var pcts = [];
      for (var i = 0; i < bin.length; i++) {
        pcts.push('%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2));
      }
      json = decodeURIComponent(pcts.join(''));
    } catch (e) {
      json = bin;   /* pure ASCII payload, or a decoder that disagrees; either way readable */
    }
    return JSON.parse(json);
  }

  function boot() {
    var mount = document.getElementById('cmd-root');
    if (!mount) return;

    var holder = document.getElementById('cmd-data');
    var view = holder ? holder.getAttribute('data-view') : 'dashboard';

    var payload;
    try {
      payload = window.CMD_PAYLOAD || decodePayload();
    } catch (e0) {
      mount.appendChild(el('div', 'note',
        'The page data could not be read: ' + (e0 && e0.message ? e0.message : e0)));
      if (window.console) window.console.error(e0);
      return;
    }
    if (!payload) return;

    try {
      if (view === 'catalog') renderCatalog(payload, mount);
      else renderDashboard(payload, mount);
    } catch (err) {
      mount.innerHTML = '';
      var box = el('div', 'panel pad');
      box.appendChild(el('div', 'h3', 'The page failed to render'));
      box.appendChild(el('p', 'sm', String(err && err.message ? err.message : err)));
      mount.appendChild(box);
      if (window.console) window.console.error(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
