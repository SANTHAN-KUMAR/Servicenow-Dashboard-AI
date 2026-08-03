/**
 * A DOM small enough to run the renderer in Node, and no smaller.
 *
 * cmd_render.js is the only part of this product that had never been executed by
 * anything except a browser we could not automate. Every other layer has a test;
 * the fifteen new chart renderers had a coverage assertion proving each form maps
 * to a distinct function, which says nothing at all about whether that function
 * throws on real data.
 *
 * This is deliberately not a DOM implementation. It supports exactly the calls the
 * renderer makes, and anything it does not support throws loudly rather than
 * returning undefined, because a shim that quietly returns undefined turns a real
 * renderer bug into a passing test. That is the failure mode worth avoiding here.
 *
 * Exported for use by test_render_live.js.
 */
'use strict';

function Node(tag, ns) {
    this.tagName = tag;
    this.namespaceURI = ns || null;
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.parentNode = null;
    this._text = '';
    this._listeners = {};
}

Node.prototype.appendChild = function (child) {
    if (child === null || child === undefined) {
        throw new Error('appendChild(' + child + ') on <' + this.tagName + '>: a ' +
            'renderer returned nothing where a node was expected');
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
};

Node.prototype.insertBefore = function (child, ref) {
    if (!child) throw new Error('insertBefore(null)');
    var at = ref ? this.childNodes.indexOf(ref) : -1;
    child.parentNode = this;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
};

Node.prototype.removeChild = function (child) {
    var at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
};

Node.prototype.setAttribute = function (k, val) {
    if (val === undefined) {
        throw new Error('setAttribute("' + k + '", undefined) on <' + this.tagName +
            '>: an undefined attribute is a silently broken mark');
    }
    /* NaN in a coordinate is the single most common way an SVG chart renders as
       nothing at all while throwing no error whatsoever. It is worth failing on. */
    if (typeof val === 'number' && isNaN(val)) {
        throw new Error('setAttribute("' + k + '", NaN) on <' + this.tagName + '>');
    }
    if (typeof val === 'string' && val.indexOf('NaN') > -1) {
        throw new Error('setAttribute("' + k + '", "' + val + '") on <' +
            this.tagName + '>: NaN in an attribute');
    }
    this.attributes[k] = String(val);
};

Node.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k)
        ? this.attributes[k] : null;
};

Node.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
};
Node.prototype.removeEventListener = function () {};

Node.prototype.getBoundingClientRect = function () {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
};

Node.prototype.querySelectorAll = function (sel) {
    /* Only the two selector shapes the renderer uses: a bare tag, and an
       attribute-presence selector. */
    var out = [];
    var attr = sel.match(/^\[([a-z-]+)\]$/);
    (function walk(n) {
        for (var i = 0; i < n.childNodes.length; i++) {
            var c = n.childNodes[i];
            if (attr) { if (c.getAttribute(attr[1]) !== null) out.push(c); }
            else if (c.tagName === sel) out.push(c);
            walk(c);
        }
    })(this);
    return out;
};

Object.defineProperty(Node.prototype, 'className', {
    get: function () { return this.attributes['class'] || ''; },
    set: function (v) { this.attributes['class'] = String(v); }
});

Object.defineProperty(Node.prototype, 'textContent', {
    get: function () { return this._text; },
    set: function (v) {
        if (v === undefined) {
            throw new Error('textContent = undefined on <' + this.tagName + '>');
        }
        if (typeof v === 'string' && /\bNaN\b|\bundefined\b/.test(v)) {
            throw new Error('textContent = "' + v + '" on <' + this.tagName +
                '>: a NaN or undefined leaked into visible copy');
        }
        this._text = String(v);
        this.childNodes = [];
    }
});

Object.defineProperty(Node.prototype, 'innerHTML', {
    get: function () { return ''; },
    set: function (v) {
        if (v !== '') throw new Error('innerHTML set to markup; the renderer is ' +
            'meant to build nodes, not strings');
        this.childNodes = [];
    }
});

Object.defineProperty(Node.prototype, 'firstChild', {
    get: function () { return this.childNodes.length ? this.childNodes[0] : null; }
});

Object.defineProperty(Node.prototype, 'offsetWidth', { get: function () { return 200; } });
Object.defineProperty(Node.prototype, 'offsetHeight', { get: function () { return 60; } });

function makeDocument() {
    var byId = {};
    var doc = {
        readyState: 'complete',
        documentElement: new Node('html'),
        body: new Node('body'),
        createElement: function (t) { return new Node(t); },
        createElementNS: function (ns, t) { return new Node(t, ns); },
        getElementById: function (id) { return byId[id] || null; },
        addEventListener: function () {},
        _register: function (id, node) { byId[id] = node; }
    };
    doc.documentElement.clientWidth = 1280;
    return doc;
}

/** Counts the nodes a render produced, so an "empty but no error" pass is visible. */
function summarise(root) {
    var counts = { total: 0, svg: 0, rect: 0, path: 0, circle: 0, text: 0,
                   line: 0, table: 0, tip: 0, hit: 0 };
    (function walk(n) {
        for (var i = 0; i < n.childNodes.length; i++) {
            var c = n.childNodes[i];
            counts.total++;
            if (Object.prototype.hasOwnProperty.call(counts, c.tagName)) counts[c.tagName]++;
            if (c.getAttribute('data-tip') !== null) counts.tip++;
            if (c.getAttribute('data-drill-field') !== null) counts.hit++;
            walk(c);
        }
    })(root);
    return counts;
}

module.exports = { Node: Node, makeDocument: makeDocument, summarise: summarise };
