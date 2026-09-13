/**
 * cmd_theme. Resolves the theme before anything paints.
 *
 * Loaded first, ahead of the fonts and the renderer, so the correct theme is on the
 * root element before the stylesheet has anything to apply it to. Doing this in the
 * renderer instead would paint light and then repaint dark, which is worse than
 * having no dark theme at all.
 *
 * Light is the default because ServiceNow runs light and this has to belong inside
 * the platform rather than visit it. A stored preference wins, and absent one the
 * operating system's preference is honoured, because a viewer who has told their
 * machine they want dark has already answered the question.
 */
(function () {
  'use strict';

  var KEY = 'cmd-theme';

  function stored() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }

  /* A page may declare the theme it was designed in. The CEO Dashboard is: its
     orbit is a lit object on a dark ground, the way the client's own references
     draw it, and it is the page most likely to be put on a wall. A viewer's own
     choice still wins, and the operating system's preference still decides every
     page that declares nothing. */
  function pageDefault() {
    var wrap = document.getElementById('cmd-wrap');
    var d = wrap ? wrap.getAttribute('data-default-theme') : null;
    return d === 'dark' || d === 'light' ? d : null;
  }

  function resolve() {
    var s = stored();
    if (s === 'dark' || s === 'light') return s;
    var p = pageDefault();
    if (p) return p;
    try {
      if (window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }

  /* Only a viewer's explicit choice is remembered. Remembering the resolved
     default as well turned the first page anyone opened into a stored preference,
     after which no page could ever declare a default of its own. */
  function apply(t, remember) {
    document.documentElement.setAttribute('data-cmd-theme', t);
    if (remember) {
      try { window.localStorage.setItem(KEY, t); } catch (e) {}
    }
  }

  apply(resolve(), false);

  window.CmdTheme = {
    get: function () {
      return document.documentElement.getAttribute('data-cmd-theme') || 'light';
    },
    set: function (t) { apply(t, true); },
    toggle: function () {
      var next = this.get() === 'dark' ? 'light' : 'dark';
      apply(next, true);
      return next;
    }
  };
})();
