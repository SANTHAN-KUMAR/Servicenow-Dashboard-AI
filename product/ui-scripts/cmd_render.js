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

    var max = niceMax(Math.max.apply(null, pts.map(function (p) { return p.count; })));
    var iw = W - padL - padR, ih = h - padT - padB;
    var x = function (i) { return padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw); };
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

    // markers, and a direct label on the last closed point only
    for (var m = 0; m < pts.length; m++) {
      s.appendChild(svgEl('circle', { cx: x(m), cy: y(pts[m].count), r: 3.4,
        fill: v('--surface'), stroke: v('--c1'), 'stroke-width': 2,
        opacity: pts[m].partial ? 0.6 : 1 }));
    }
    s.appendChild(valueLabel(x(lastClosed), y(pts[lastClosed].count) - 10,
      fmt(pts[lastClosed].count), 'vl'));

    // x labels, thinned so they never collide
    /* Thinned, and the final label is only forced when it is not adjacent to one
       already drawn. Forcing it unconditionally overlapped "Jul '26" with
       "Aug '26" into an unreadable smear. */
    var every = Math.max(1, Math.ceil(pts.length / (W >= 800 ? 9 : 6)));
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
      s.appendChild(svgEl('rect', {
        x: padL, y: yy, width: w, height: barH, rx: 4,
        fill: rows[i].isOther ? v(OTHER) : v('--c1')
      }));
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
      s.appendChild(svgEl('rect', { x: cx - bw / 2, y: padT + ih - bh, width: bw,
        height: bh, rx: 4, fill: rows[i].isOther ? v(OTHER) : v('--c1') }));
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
    if (!total) return s;

    var x = padL, iw = W - padL - padR;
    for (var i = 0; i < rows.length; i++) {
      var w = (rows[i].count / total) * iw;
      var seg = Math.max(0, w - (i < rows.length - 1 ? 2 : 0));
      var colour = rows[i].isOther ? v(OTHER)
                 : ordinal ? v(SEQ[Math.min(SEQ.length - 1,
                     2 + Math.floor(i * (SEQ.length - 3) / Math.max(1, rows.length - 1)))])
                 : catColour(i);
      s.appendChild(svgEl('rect', { x: x, y: barY, width: seg, height: barH,
        rx: i === 0 || i === rows.length - 1 ? 4 : 0, fill: colour }));
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
    if (!total) return s;

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
      s.appendChild(svgEl('path', {
        d: arc(cx, cy, r, r - thick, a0, Math.max(a0, a1 - gapA)),
        fill: rows[i].isOther ? v(OTHER) : catColour(i)
      }));
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
    if (!total) return s;

    var items = rows.map(function (r, i) {
      return { row: r, value: r.count, idx: i };
    }).filter(function (x) { return x.value > 0; });

    var cells = squarify(items, 0, 0, W, h, total);
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var step = Math.min(SEQ.length - 1,
        1 + Math.floor((1 - i / Math.max(1, cells.length - 1)) * (SEQ.length - 2)));
      s.appendChild(svgEl('rect', {
        x: c.x + 1, y: c.y + 1,
        width: Math.max(0, c.w - 2), height: Math.max(0, c.h - 2),
        rx: 3,
        fill: c.item.row.isOther ? v(OTHER) : v(SEQ[step])
      }));
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
      s.appendChild(svgEl('rect', { x: padL + slot * k + 0.5, y: padT + ih - bh,
        width: Math.max(1, slot - 1), height: bh, rx: 2, fill: v('--c1') }));
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

  /* The honest list of what renders. A form the engine can emit that is missing
     here falls back to the table view with a note, rather than a blank panel. */
  var FORMS = {
    line: function (p) { return drawLine(p, false); },
    area: function (p) { return drawLine(p, true); },
    line_multi: function (p) { return drawLine(p, false); },
    column: drawColumn,
    ranked_bar: drawRankedBar,
    ranked_bar_top_n: drawRankedBar,
    pareto: drawRankedBar,
    stacked_proportion: function (p) { return drawStackedProportion(p, false); },
    stacked_ordinal: function (p) { return drawStackedProportion(p, true); },
    donut: function (p) { return drawDonut(p, false); },
    semi_donut: function (p) { return drawDonut(p, true); },
    treemap: drawTreemap,
    histogram: drawHistogram,
    stat_tile: drawStatTile,
    stat_tile_delta: drawStatTile
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
    p.appendChild(head);

    var body = el('div', 'cp-b');
    W = (panel.span === 2) ? W_SPAN2 : W_SINGLE;
    var draw = FORMS[panel.form];
    if (draw) {
      body.appendChild(draw(panel));
    } else {
      var note = el('div', 'cav', 'No renderer for "' + panel.form +
        '" yet, so the data is shown as a table.');
      body.appendChild(note);
      body.appendChild(drawTable(panel));
    }
    p.appendChild(body);

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
    sub.appendChild(el('span', '', fmt(payload.subject.rows) + ' records'));
    sub.appendChild(el('span', 'dot', '·'));
    sub.appendChild(el('span', '', 'built in ' + payload.timingMs + 'ms'));
    left.appendChild(sub);
    h.appendChild(left);

    var right = el('div', 'app-h-r');
    right.appendChild(aclChip(payload.acl));
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
      c.title = fmt(acl.delta) + ' records exist that you cannot read. They are ' +
                'excluded from every number on this page.';
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

    if (payload.notes && payload.notes.length) {
      for (var n = 0; n < payload.notes.length; n++) {
        mount.appendChild(el('div', 'note', payload.notes[n]));
      }
    }

    var grid = el('div', 'grid-panels');
    for (var i = 0; i < payload.panels.length; i++) {
      grid.appendChild(buildPanel(payload.panels[i], payload));
    }
    var dp = buildDrillPanel(payload);
    if (dp) grid.appendChild(dp);
    var decl = buildDeclaredPanel(payload);
    if (decl) grid.appendChild(decl);
    mount.appendChild(grid);
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

    var stats = el('div', 'card-stats');
    stats.appendChild(stat(k.capped ? compact(k.rows) + '+' : compact(k.rows), 'records'));
    stats.appendChild(stat(String(k.dimensions), 'dimensions'));
    stats.appendChild(stat(String(k.reports), 'reports'));
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
