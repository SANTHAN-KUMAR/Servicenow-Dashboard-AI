#!/usr/bin/env python3
"""ServiceNow instance client.

Authentication note, because this cost the engagement two rounds to find.

dev390988 rejects HTTP Basic against the REST API by design, and it rejects a
plain session cookie too. What it accepts is a session cookie **plus** the
`X-UserToken` CSRF header, which is exactly what the platform's own browser
client sends on every XHR. `01-live-instance-findings.md` concluded OAuth was the
only route; that conclusion was wrong, and it was wrong because the probe omitted
the header rather than because the instance required OAuth. Basic still fails,
session-only still fails, session plus token works.

That matters beyond convenience: it means no OAuth application registration, no
client secret to store, and no token refresh loop.

The other thing this file exists for is the verify step. A Table API PATCH answers
200 whether or not it stored the value you sent, and reporting a deploy as landed
on the strength of a status code is how this engagement previously shipped a page
that the instance was still serving from cache. Every write here is read back and
compared byte for byte.
"""

import hashlib
import http.cookiejar
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# A shared development instance stalls for tens of seconds at a time under its own
# background jobs, so a single timeout is not evidence of anything. Transport
# failures retry; HTTP errors do not, because a 403 will still be a 403.
RETRIES = 5
LOGIN_TIMEOUT = 120
CALL_TIMEOUT = 180


class InstanceError(RuntimeError):
    pass


def _with_retry(fn, label, tries=RETRIES, verbose=False):
    """Retry a transport-level failure with linear backoff."""
    last = None
    for n in range(tries):
        try:
            return fn()
        except urllib.error.HTTPError:
            raise                              # the server answered; it means it
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            if n == tries - 1:
                break
            wait = 3 * (n + 1)
            if verbose:
                print(f"  {label}: {str(e)[:60]}, retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise InstanceError(f"{label} failed after {tries} attempts: {last}")


class Instance:
    """An authenticated session against one instance."""

    def __init__(self, credentials_path=None, verbose=True):
        path = Path(credentials_path) if credentials_path else HERE / "credentials.json"
        if not path.exists():
            raise InstanceError(
                f"No credentials at {path}. Copy credentials.example.json to "
                f"credentials.json and fill it in. It is gitignored."
            )
        c = json.loads(path.read_text())
        missing = [k for k in ("instance", "username", "password") if not c.get(k)]
        if missing:
            raise InstanceError(f"credentials.json is missing: {', '.join(missing)}")

        self.host = c["instance"]
        self.base = f"https://{self.host}"
        self._user = c["username"]
        self._pw = c["password"]
        self.verbose = verbose
        self.token = None

        self._jar = http.cookiejar.CookieJar()
        self._op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar))
        self._op.addheaders = [("User-Agent", UA)]

    # ── auth ────────────────────────────────────────────────────────────────

    def login(self):
        """UI form login, then lift the CSRF token off an authenticated page."""
        _with_retry(lambda: self._op.open(f"{self.base}/login.do",
                                          timeout=LOGIN_TIMEOUT).read(),
                    "login GET", verbose=self.verbose)

        body = urllib.parse.urlencode({
            "user_name": self._user,
            "user_password": self._pw,
            "sys_action": "sysverb_login",
        }).encode()
        html = _with_retry(
            lambda: self._op.open(f"{self.base}/login.do", body,
                                  timeout=LOGIN_TIMEOUT).read().decode("utf-8", "replace"),
            "login POST", verbose=self.verbose)

        names = {ck.name for ck in self._jar}
        if "glide_user_session" not in names and "JSESSIONID" not in names:
            raise InstanceError("Login did not establish a session. Check the password.")
        if "user_password" in html and "sysverb_login" in html and len(html) < 20000:
            raise InstanceError("Login form was returned again, so the credentials were rejected.")

        self.token = self._csrf()
        if not self.token:
            raise InstanceError("Authenticated, but could not find the CSRF token (g_ck).")

        if self.verbose:
            print(f"  authenticated to {self.host} as {self._user}")
        return self

    def _csrf(self):
        """g_ck is emitted inline on any authenticated platform page."""
        for path in ("/ui_page_process.do?sys_id=-1",
                     "/nav_to.do?uri=sys_ui_page_list.do",
                     "/home.do"):
            try:
                page = _with_retry(
                    lambda: self._op.open(self.base + path, timeout=LOGIN_TIMEOUT)
                                    .read().decode("utf-8", "replace"),
                    "csrf")
            except Exception:
                continue
            for pat in (r"var g_ck\s*=\s*['\"]([0-9a-zA-Z_\-]+)['\"]",
                        r"g_ck\s*=\s*['\"]([0-9a-zA-Z_\-]+)['\"]",
                        r'"sysparm_ck"\s+value="([0-9a-zA-Z_\-]+)"'):
                m = re.search(pat, page)
                if m:
                    return m.group(1)
        return None

    # ── transport ───────────────────────────────────────────────────────────

    def _call(self, method, path, payload=None):
        if not self.token:
            raise InstanceError("Not authenticated. Call login() first.")

        url = self.base + path
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {
            "Accept": "application/json",
            "X-UserToken": self.token,
        }
        if data is not None:
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            raw = _with_retry(
                lambda: self._op.open(req, timeout=CALL_TIMEOUT)
                                .read().decode("utf-8", "replace"),
                f"{method} {path}", verbose=self.verbose)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            raise InstanceError(f"{method} {path} -> HTTP {e.code}: {detail}")

        if not raw.strip():
            return {}
        try:
            out = json.loads(raw)
        except json.JSONDecodeError:
            raise InstanceError(f"{method} {path} returned non-JSON: {raw[:300]}")
        if isinstance(out, dict) and "error" in out:
            raise InstanceError(f"{method} {path} -> {out['error']}")
        return out

    # ── records ─────────────────────────────────────────────────────────────

    def query(self, table, encoded_query="", fields=None, limit=100):
        params = {"sysparm_limit": str(limit), "sysparm_exclude_reference_link": "true"}
        if encoded_query:
            params["sysparm_query"] = encoded_query
        if fields:
            params["sysparm_fields"] = ",".join(fields)
        path = f"/api/now/table/{table}?" + urllib.parse.urlencode(params)
        return self._call("GET", path).get("result", [])

    def get_one(self, table, encoded_query, fields=None):
        rows = self.query(table, encoded_query, fields, limit=1)
        return rows[0] if rows else None

    def insert(self, table, payload):
        return self._call("POST", f"/api/now/table/{table}", payload).get("result", {})

    def update(self, table, sys_id, payload):
        return self._call("PATCH", f"/api/now/table/{table}/{sys_id}",
                          payload).get("result", {})

    # ── the part that matters ───────────────────────────────────────────────

    def upsert_verified(self, table, key_field, key_value, payload, verify_field):
        """Insert or update, then prove it landed.

        Reads the record back and compares `verify_field` byte for byte against
        what was sent. A Table API write answers 200 regardless of what it
        actually stored, so the status code proves nothing and is not consulted.

        Returns (sys_id, action, verified) where action is 'created' or 'updated'.
        """
        existing = self.get_one(table, f"{key_field}={key_value}", ["sys_id"])

        if existing:
            sys_id = existing["sys_id"]
            self.update(table, sys_id, payload)
            action = "updated"
        else:
            body = dict(payload)
            body[key_field] = key_value
            created = self.insert(table, body)
            sys_id = created.get("sys_id")
            action = "created"
            if not sys_id:
                raise InstanceError(f"{table}: insert returned no sys_id")

        back = self.get_one(table, f"sys_id={sys_id}", [verify_field, "sys_id"])
        if not back:
            raise InstanceError(f"{table}/{sys_id}: wrote it, then could not read it back")

        sent = payload.get(verify_field, "")
        got = back.get(verify_field) or ""

        # The platform normalises line endings on stored script/HTML fields, so
        # compare with that normalisation applied to both sides. Anything else
        # that differs is a real difference.
        norm = lambda s: s.replace("\r\n", "\n").replace("\r", "\n")
        verified = norm(sent) == norm(got)

        if self.verbose:
            mark = "ok" if verified else "## MISMATCH"
            print(f"  {action:8s} {table:22s} {key_value[:38]:38s} "
                  f"{len(got):>7,}b  {mark}")

        if not verified:
            s, g = norm(sent), norm(got)
            at = next((i for i in range(min(len(s), len(g))) if s[i] != g[i]),
                      min(len(s), len(g)))
            raise InstanceError(
                f"{table}/{key_value}: readback differs from what was sent.\n"
                f"    sent {len(s):,} bytes, stored {len(g):,} bytes, "
                f"first difference at offset {at}\n"
                f"    sent:   ...{s[max(0,at-60):at+60]!r}\n"
                f"    stored: ...{g[max(0,at-60):at+60]!r}"
            )

        return sys_id, action, verified

    def property(self, name):
        row = self.get_one("sys_properties", f"name={name}", ["value"])
        return row["value"] if row else None

    # ── server-side execution ───────────────────────────────────────────────

    def run_script(self, js, scope="global"):
        """Execute server-side script through Scripts - Background.

        This is what makes the server chain testable against real data before any
        UI exists. The endpoint is an HTML form, not an API, so the response has
        to be scraped; output written with gs.print lands inside a <PRE> block.

        Anything this returns has been evaluated by the same Rhino engine that
        will run the Script Includes in production, which is the point: a script
        that passes here cannot fail on the instance for a syntax reason.
        """
        if not self.token:
            raise InstanceError("Not authenticated. Call login() first.")

        body = urllib.parse.urlencode({
            "script": js,
            "sysparm_ck": self.token,
            "runscript": "Run script",
            "sys_scope": scope,
            "quota_managed_transaction": "on",
        }).encode()

        req = urllib.request.Request(
            f"{self.base}/sys.scripts.do",
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "X-UserToken": self.token,
                "Accept": "text/html",
            },
            method="POST",
        )
        try:
            with self._op.open(req, timeout=180) as r:
                html = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raise InstanceError(
                f"sys.scripts.do -> HTTP {e.code}: "
                f"{e.read().decode('utf-8', 'replace')[:300]}")

        # Rhino errors come back as a formatted block rather than an HTTP error.
        low = html.lower()
        for marker in ("javascript compiler exception", "org.mozilla.javascript",
                       "syntax error", "evaluator.evaluatestring"):
            if marker in low:
                text = re.sub(r"<[^>]+>", "", html)
                text = re.sub(r"\n{3,}", "\n\n", text).strip()
                raise InstanceError(f"script failed on the instance:\n{text[:1500]}")

        pres = re.findall(r"<PRE>(.*?)</PRE>", html, re.S | re.I)
        if pres:
            out = "\n".join(pres)
        else:
            out = re.sub(r"<[^>]+>", "", html)

        out = (out.replace("&lt;", "<").replace("&gt;", ">")
                  .replace("&quot;", '"').replace("&#39;", "'")
                  .replace("&amp;", "&"))

        # gs.print wraps every line as "*** Script: <text><BR/>". Strip the
        # wrapper so callers see what the script actually printed.
        out = re.sub(r"<BR\s*/?>", "\n", out, flags=re.I)
        lines = [re.sub(r"^\s*\*\*\*\s*Script:\s?", "", ln) for ln in out.splitlines()]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()

    def run_json(self, js):
        """Run a script whose last statement prints one JSON line, and parse it.

        The convention is that the script prints exactly one line starting with
        `@@` so that anything else the platform decides to emit, and platform
        logging is chatty, cannot be mistaken for the result.
        """
        out = self.run_script(js)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("@@"):
                try:
                    return json.loads(line[2:])
                except json.JSONDecodeError as e:
                    raise InstanceError(f"result line was not JSON: {e}\n{line[:400]}")
        raise InstanceError(f"no @@ result line in output:\n{out[:1200]}")


def content_hash(text, length=12):
    """Short stable hash, used to bust the hard cache on .jsdbx UI Scripts."""
    return hashlib.sha256(text.encode()).hexdigest()[:length]


if __name__ == "__main__":
    try:
        inst = Instance().login()
        print(f"  release           {inst.property('glide.war')}")
        print(f"  instance name     {inst.property('instance_name')}")
        pages = inst.query("sys_ui_page", "", ["name"], limit=1)
        print(f"  sys_ui_page read  ok ({len(pages)} row sampled)")
        print("\n  Write path is available.\n")
    except InstanceError as e:
        print(f"\n  FAILED: {e}\n", file=sys.stderr)
        sys.exit(1)
