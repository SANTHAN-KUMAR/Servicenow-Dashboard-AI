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

  function resolve() {
    var s = stored();
    if (s === 'dark' || s === 'light') return s;
    try {
      if (window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }

  function apply(t) {
    document.documentElement.setAttribute('data-cmd-theme', t);
    try { window.localStorage.setItem(KEY, t); } catch (e) {}
  }

  apply(resolve());

  window.CmdTheme = {
    get: function () {
      return document.documentElement.getAttribute('data-cmd-theme') || 'light';
    },
    set: apply,
    toggle: function () {
      var next = this.get() === 'dark' ? 'light' : 'dark';
      apply(next);
      return next;
    }
  };
})();
