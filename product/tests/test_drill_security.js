/**
 * Regression test for the query-injection half of the F1 finding in the
 * 2026-08-10 adversarial review (docs/use-case-2/13-adversarial-review-findings.md).
 *
 * A drill path arrives from a URL query parameter -- decoded, otherwise
 * unvalidated -- and CmdDrill.stepQuery concatenates `field + '=' + key`
 * straight into an encoded query. Before this fix, neither `field` nor `key`
 * was checked, so a crafted URL could name an arbitrary field, or put an
 * encoded-query operator (`^OR`, `^NQ`) inside a value that should have been a
 * plain string. Confirmed live on dev390988: `category:software^ORsys_idISNOTEMPTY`
 * turned "drill into Software" into "return the whole table," still labelled
 * VERIFIED, because CmdData._trustedFor treated the widened query as a subset
 * of an already-proven one.
 *
 * CmdDrill.sanitizePath is the first of the two independent fixes: cut the
 * drill path down to its longest prefix of segments whose field is a real
 * dimension on the table and whose key contains no '^'. The second fix,
 * CmdData._trustedFor refusing to transfer trust across a widening operator, is
 * tested in test_data_helpers.js so it stands on its own regardless of whether
 * a query reached it through this path or any other caller.
 *
 * Run with: node product/tests/test_drill_security.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = path.join(__dirname, '..', 'script-includes', 'CmdDrill.js');

var sandbox = {
    /* CmdDrill.js is `var CmdDrill = Class.create(); CmdDrill.prototype = {...}`,
       ServiceNow's usual Prototype.js-style class. The constructor this returns
       has to call the prototype's `initialize` -- assigned a line later, so it
       must be looked up at construction time, not captured now -- or `this.meta`
       is never set and every method reads through undefined. */
    Class: {
        create: function () {
            return function () {
                if (this.initialize) this.initialize.apply(this, arguments);
            };
        }
    },
    GlideRecord: function () {},
    GlideRecordSecure: function () {},
    GlideAggregate: function () {},
    GlideDateTime: function () {},
    gs: { print: function () {} }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected),
       'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

/* A stub CmdMeta exposing exactly what sanitizePath reads: dimensions(table) ->
   [{name, ...}]. `category` and `priority` are real dimensions on `incident`;
   `sys_id` and `active` are deliberately absent, matching a real table where
   sys_id is not offered as a drillable dimension. */
function fakeMeta() {
    return {
        dimensions: function (table) {
            if (table !== 'incident') return [];
            return [{ name: 'category' }, { name: 'priority' }, { name: 'active' }];
        }
    };
}

function drill() {
    var C = sandbox.CmdDrill;
    return new C({}, fakeMeta());
}

console.log('CmdDrill.sanitizePath — the drill-path half of the F1 fix\n');

var d = drill();

eq('a normal one-level drill passes through unchanged',
   d.sanitizePath('incident', [{ field: 'category', key: 'software' }]),
   [{ field: 'category', key: 'software' }]);

eq('a normal two-level drill passes through unchanged',
   d.sanitizePath('incident', [
       { field: 'category', key: 'software' },
       { field: 'priority', key: '1' }
   ]),
   [
       { field: 'category', key: 'software' },
       { field: 'priority', key: '1' }
   ]);

eq('the live-confirmed injection is stripped: OR widening in the key',
   d.sanitizePath('incident', [
       { field: 'category', key: 'software^ORsys_idISNOTEMPTY' }
   ]),
   []);

eq('NQ widening in the key is stripped the same way',
   d.sanitizePath('incident', [
       { field: 'category', key: 'software^NQsys_idISNOTEMPTY' }
   ]),
   []);

eq('a field not on the table\'s dimension list is stripped',
   d.sanitizePath('incident', [{ field: 'sys_id', key: 'anything' }]),
   []);

eq('a poisoned second level truncates the path to the good first level, ' +
   'not "everything except the bad part"',
   d.sanitizePath('incident', [
       { field: 'category', key: 'software' },
       { field: 'priority', key: '1^ORsys_idISNOTEMPTY' },
       { field: 'active', key: 'true' }
   ]),
   [{ field: 'category', key: 'software' }]);

eq('a poisoned first level truncates to nothing, even though a later level ' +
   'looks fine on its own',
   d.sanitizePath('incident', [
       { field: 'category', key: 'software^ORsys_idISNOTEMPTY' },
       { field: 'priority', key: '1' }
   ]),
   []);

eq('an empty key (the "(none)" bucket) is a real, legitimate drill, not stripped',
   d.sanitizePath('incident', [{ field: 'category', key: '' }]),
   [{ field: 'category', key: '' }]);

eq('an unknown table has no dimensions, so any path is stripped',
   d.sanitizePath('other_table', [{ field: 'category', key: 'software' }]),
   []);

eq('an empty path stays empty', d.sanitizePath('incident', []), []);
eq('no path at all is handled without throwing', d.sanitizePath('incident', null), []);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
