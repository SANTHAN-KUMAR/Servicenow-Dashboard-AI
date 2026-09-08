#!/usr/bin/env python3
"""The permission-proof cache, checked against a live instance.

    python3 product/tests/verdict_cache_live.py

The proof is the expensive thing on a page and it is reused within a session. That
is only sound while every one of its guards holds, and every guard is about
refusing to reuse: a changed row count, an expired entry, a proof that was never
trusted, a corrupted entry. This asserts all of them against the real session
store rather than a stub, because the store is the part that has to be trusted.

Correctness note. The entry lives in the viewer's session, so it cannot be handed
to another user. That property is structural rather than tested here -- there is
no way to express the mistake -- and it is the reason the session was chosen over
a shared cache.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from snclient import Instance, InstanceError  # noqa: E402

PROBE = r"""
var out = {};
var d = new CmdData();
var T = 'incident', Q = '';
var K = 'cmd.acl.v1.' + T + '|' + Q;

d.aclVerdict(T, Q);
var real = d.fastCount(T, Q);

out.cold_is_trusted = d.aclVerdict(T, Q).trusted === true;
out.same_count_hits = !!d._recallTrust(T, Q, real);
out.one_more_misses = !d._recallTrust(T, Q, real + 1);
out.one_fewer_misses = !d._recallTrust(T, Q, real - 1);
out.other_query_misses = !d._recallTrust(T, 'category=hardware', real);

gs.getSession().putClientData(K, JSON.stringify(
    { trusted: true, count: real, at: new Date().getTime() - (CmdData.VERDICT_TTL_MS + 5000) }));
out.expired_misses = !d._recallTrust(T, Q, real);

gs.getSession().putClientData(K, JSON.stringify(
    { trusted: false, count: real, at: new Date().getTime() }));
out.untrusted_misses = !d._recallTrust(T, Q, real);

gs.getSession().putClientData(K, 'not json at all');
out.garbage_misses = !d._recallTrust(T, Q, real);

/* And the point of the whole thing. */
gs.getSession().putClientData(K, '');
var d2 = new CmdData();
var c0 = new Date().getTime(); d2.aclVerdict(T, Q); out.cold_ms = new Date().getTime() - c0;
var d3 = new CmdData();
var w0 = new Date().getTime(); d3.aclVerdict(T, Q); out.warm_ms = new Date().getTime() - w0;

gs.info('@@' + JSON.stringify(out));
"""

EXPECTED = ["cold_is_trusted", "same_count_hits", "one_more_misses",
            "one_fewer_misses", "other_query_misses", "expired_misses",
            "untrusted_misses", "garbage_misses"]


def main():
    inst = Instance(verbose=False).login()
    r = inst.run_json(PROBE, scope="global")

    failed = 0
    for name in EXPECTED:
        ok = r.get(name) is True
        if not ok:
            failed += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")

    cold, warm = r.get("cold_ms", 0), r.get("warm_ms", 0)
    print(f"\n  cold proof {cold:,} ms   reused {warm:,} ms")
    if warm >= cold and cold > 50:
        print("  FAIL  reusing the proof saved nothing")
        failed += 1

    print(f"\n  {len(EXPECTED) - failed}/{len(EXPECTED)} guards correct\n")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
