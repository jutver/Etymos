"""
Tests for the support system: backend/api/support.py (tickets, routes),
support_mail.py (threaded outgoing email) and support_inbound.py (email
replies). Supabase, Storage and SMTP are in-memory fakes; nothing is sent
and no mailbox is contacted. Like test_recovery_email.py, the router is
mounted on a small standalone app.
"""
from __future__ import annotations

import itertools
import re
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.middleware import SlowAPIMiddleware

import notifications
import rate_limit
import support
import support_inbound
import support_mail
from auth import AuthedUser, verify_supabase_jwt
from email_templates import SUPPORT_REPLY_MARKER

ADMIN_ID = "00000000-0000-4000-8000-000000000001"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PDF = b"%PDF-1.7\n" + b"\x00" * 64


# --- in-memory stand-in for the supabase-py query builder and Storage --------------


def _ts(v):
    return notifications._parse_ts(v) if isinstance(v, str) else v


class _Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.op, self.payload, self.opts = [], "select", None, {}
        self.order_by, self.slice, self.want_count = [], None, False

    def select(self, *_, count=None):
        self.want_count = count == "exact"
        return self

    def _f(self, fn):
        self.filters.append(fn)
        return self

    def eq(self, c, v):
        return self._f(lambda r: r.get(c) == v)

    def in_(self, c, vs):
        return self._f(lambda r: r.get(c) in vs)

    def is_(self, c, v):
        assert v == "null"
        return self._f(lambda r: r.get(c) is None)

    def gte(self, c, v):
        return self._f(lambda r: r.get(c) is not None and _ts(r[c]) >= _ts(v))

    def lte(self, c, v):
        return self._f(lambda r: r.get(c) is not None and _ts(r[c]) <= _ts(v))

    def or_(self, expr):
        terms = []
        for part in expr.split(","):
            col, _, pattern = part.split(".", 2)
            terms.append((col, pattern.strip("*").lower()))
        return self._f(lambda r: any(t in (r.get(c) or "").lower() for c, t in terms))

    def order(self, col, desc=False):
        self.order_by.append((col, desc))
        return self

    def limit(self, n):
        self.slice = (0, n)
        return self

    def range(self, a, b):
        self.slice = (a, b + 1)
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def upsert(self, payload, on_conflict=None, ignore_duplicates=False):
        self.op, self.payload = "upsert", payload
        self.opts = {"keys": on_conflict.split(","), "ignore": ignore_duplicates}
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            for col, desc in reversed(self.order_by):
                match.sort(key=lambda r: (r.get(col) is None, r.get(col) or ""), reverse=desc)
            total = len(match)
            if self.slice:
                match = match[self.slice[0] : self.slice[1]]
            return SimpleNamespace(data=[dict(r) for r in match], count=total if self.want_count else None)
        if self.op == "insert":
            payloads = self.payload if isinstance(self.payload, list) else [self.payload]
            out = []
            for p in payloads:
                row = self.db.defaults(self.table, p)
                for col in self.db.unique.get(self.table, ()):
                    if row.get(col) is not None and any(r.get(col) == row[col] for r in rows):
                        raise RuntimeError(f"duplicate {col}")
                rows.append(row)
                out.append(dict(row))
            return SimpleNamespace(data=out, count=None)
        if self.op == "upsert":
            keys = self.opts["keys"]
            existing = [r for r in rows if all(r.get(k) == self.payload.get(k) for k in keys)]
            if existing:
                if self.opts["ignore"]:
                    return SimpleNamespace(data=[], count=None)
                existing[0].update(self.payload)
                return SimpleNamespace(data=[dict(existing[0])], count=None)
            row = self.db.defaults(self.table, self.payload)
            rows.append(row)
            return SimpleNamespace(data=[dict(row)], count=None)
        if self.op == "update":
            for r in match:
                r.update(self.payload)
            return SimpleNamespace(data=[dict(r) for r in match], count=None)
        if self.op == "delete":
            self.db.tables[self.table] = [r for r in rows if r not in match]
            return SimpleNamespace(data=match, count=None)
        raise AssertionError(self.op)


class _Bucket:
    def __init__(self, db):
        self.db = db

    def upload(self, path, data, file_options=None):
        self.db.files[path] = data

    def create_signed_url(self, path, ttl):
        return {"signedURL": f"https://storage.test/{path}?ttl={ttl}"}

    def remove(self, paths):
        for p in paths:
            self.db.files.pop(p, None)


class FakeDB:
    def __init__(self):
        self.files: dict = {}
        self._numbers = itertools.count(1001)
        self.unique = {"support_messages": ("email_message_id",), "support_inbound_log": ("message_id",)}
        self.tables = {
            "profiles": [
                {"id": ADMIN_ID, "email": "boss@etymos.site", "display_name": "Boss", "role": "admin", "plan_tier": "free"},
                {"id": "user-1", "email": "owner@example.com", "display_name": "Owner", "role": "user", "plan_tier": "student"},
                {"id": "user-2", "email": "other@example.com", "display_name": "Other", "role": "user", "plan_tier": "free"},
            ],
            "recovery_emails": [
                {"user_id": "user-1", "email": "backup@example.com", "verified_at": "2026-10-01T00:00:00+00:00"}
            ],
            "notification_log": [],
        }
        self.storage = SimpleNamespace(from_=lambda _bucket: _Bucket(self))

    def defaults(self, table, payload):
        row = {"id": str(uuid.uuid4()), "created_at": support._iso(), **payload}
        if table == "support_tickets":
            row.setdefault("number", next(self._numbers))
            for k in ("assigned_to", "resolved_at", "closed_at", "last_agent_message_at"):
                row.setdefault(k, None)
            row.setdefault("priority", "normal")
        if table == "support_messages":
            row.setdefault("sender_mismatch", False)
            for k in ("email_message_id", "raw_email_path", "sender_auth", "sender_email", "author_id"):
                row.setdefault(k, None)
        if table == "support_inbound_log":
            row.setdefault("updated_at", support._iso())
        return row

    def table(self, name):
        return _Query(self, name)


USER = AuthedUser(user_id="user-1", email="owner@example.com", role="user", is_admin=False)
OTHER = AuthedUser(user_id="user-2", email="other@example.com", role="user", is_admin=False)
ADMIN = AuthedUser(user_id=ADMIN_ID, email="boss@etymos.site", role="admin", is_admin=True)


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    support_sent: list = []  # support_mail.send kwargs
    alerts: list = []  # (to, content) through notifications/mailer
    fail = {"support": 0}

    def fake_support_send(**kw):
        if fail["support"]:
            fail["support"] -= 1
            raise OSError("SMTP down")
        support_sent.append(kw)

    for module in (support, support_inbound, notifications):
        monkeypatch.setattr(module, "get_client", lambda: db)
    monkeypatch.setattr(support_mail, "send", fake_support_send)
    monkeypatch.setattr(support_mail, "is_configured", lambda: True)
    monkeypatch.setattr(notifications.mailer, "is_configured", lambda: True)
    monkeypatch.setattr(notifications.mailer, "send_email", lambda to, c: alerts.append((to, c)))
    monkeypatch.setenv("SUPPORT_LINK_SECRET", "x" * 40)
    monkeypatch.setenv("SUPPORT_EMAIL", "support@etymos.site")
    monkeypatch.delenv("SUPPORT_ALERT_EMAILS", raising=False)
    monkeypatch.delenv("ADMIN_ALERT_EMAILS", raising=False)

    current = {"user": None}

    def current_user():
        if current["user"] is None:
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="Missing bearer token.")
        return current["user"]

    app = FastAPI()
    app.state.limiter = rate_limit.limiter
    app.add_middleware(SlowAPIMiddleware)
    app.include_router(support.router)
    app.dependency_overrides[verify_supabase_jwt] = current_user
    app.dependency_overrides[support.optional_user] = lambda: current["user"]
    rate_limit.limiter.reset()
    return SimpleNamespace(
        client=TestClient(app), db=db, support_sent=support_sent, alerts=alerts, current=current, fail=fail
    )


def open_form(env, *, as_user=None, email="guest@example.com", files=None, **over):
    env.current["user"] = as_user
    data = {"category": "billing", "subject": "Charged twice", "body": "I paid twice for one pack.", **over}
    if as_user is None and email is not None:
        data["email"] = email
    return env.client.post("/api/support/tickets", data=data, files=files or [])


def tickets(env):
    return env.db.tables.get("support_tickets", [])


def messages(env, ticket=None):
    rows = env.db.tables.get("support_messages", [])
    return [m for m in rows if ticket is None or m["ticket_id"] == ticket["id"]]


# --- helpers --------------------------------------------------------------------


def test_guest_token_round_trip_and_tamper(monkeypatch):
    monkeypatch.setenv("SUPPORT_LINK_SECRET", "s" * 40)
    tid = str(uuid.uuid4())
    token = support.guest_token(tid)
    assert support.ticket_id_from_guest_token(token) == tid
    assert support.ticket_id_from_guest_token(token[:-1] + ("0" if token[-1] != "0" else "1")) is None
    assert support.ticket_id_from_guest_token("nonsense") is None
    monkeypatch.setenv("SUPPORT_LINK_SECRET", "t" * 40)
    assert support.ticket_id_from_guest_token(token) is None  # rotating the secret revokes links
    monkeypatch.setenv("SUPPORT_LINK_SECRET", "short")
    assert support.guest_token(tid) is None


def test_file_checks_use_real_content():
    ok = support.validate_files([support.IncomingFile("shot", "text/plain", PNG)])
    assert ok[0].content_type == "image/png" and ok[0].filename == "shot.png"
    with pytest.raises(Exception) as e:
        support.validate_files([support.IncomingFile("evil.png", "image/png", b"MZ\x90\x00 not an image")])
    assert e.value.detail == "file_type"
    with pytest.raises(Exception) as e:
        support.validate_files([support.IncomingFile("a.png", "image/png", PNG)] * 6)
    assert e.value.detail == "too_many_files"
    assert support.safe_filename("../../etc/pa ss<wd>.pdf", "application/pdf") == "pa ss_wd_.pdf"


def test_clean_text_drops_control_characters():
    assert support.clean_text("  hi\x00\r\nthere\x07  ", limit=100) == "hi\nthere"


# --- opening tickets ------------------------------------------------------------------


def test_guest_opens_a_ticket(env):
    r = open_form(env, email="Guest@Example.com", name="Lan", files=[("files", ("s.png", PNG, "image/png"))])
    assert r.status_code == 200, r.text
    assert r.json() == {"number": 1001, "signed_in": False}
    t = tickets(env)[0]
    assert t["requester_email"] == "guest@example.com" and t["user_id"] is None
    assert t["identity_verified"] is False and t["status"] == "open"
    assert len(env.db.tables["support_attachments"]) == 1

    ack = env.support_sent[0]
    assert ack["to"] == "guest@example.com" and ack["auto_reply"] is True
    assert ack["content"].subject == "[#1001] Charged twice"
    assert ack["content"].top_line == SUPPORT_REPLY_MARKER
    assert "/support/t/" in ack["content"].button_url
    # The ack's Message-ID is kept, so a reply to it threads in.
    assert any(m["email_message_id"] == ack["message_id"] for m in messages(env))
    assert [to for to, _ in env.alerts] == ["boss@etymos.site"]


def test_signed_in_ticket_is_verified_and_linked(env):
    r = open_form(env, as_user=USER, email="ignored@example.com")
    t = tickets(env)[0]
    assert r.json()["signed_in"] is True
    assert t["user_id"] == "user-1" and t["requester_email"] == "owner@example.com" and t["identity_verified"]
    assert env.support_sent[0]["content"].button_url.endswith("/account/support/1001")


def test_form_validation(env):
    assert open_form(env, email="nope").json()["detail"] == "invalid_email"
    assert open_form(env, body="   ").json()["detail"] == "invalid_body"
    assert open_form(env, category="spam").json()["detail"] == "invalid_category"
    assert open_form(env, website="http://bot").status_code == 400
    bad = [("files", ("x.png", b"<?php", "image/png"))]
    assert open_form(env, files=bad).json()["detail"] == "file_type"
    assert tickets(env) == []


def test_tickets_per_address_are_capped(env):
    for _ in range(support.TICKETS_PER_EMAIL_PER_HOUR):
        assert open_form(env, email="victim@example.com").status_code == 200
    r = open_form(env, email="victim@example.com")
    assert r.status_code == 429 and r.json()["detail"] == "too_many_requests"


def test_alerts_never_go_to_the_support_mailbox(env, monkeypatch):
    monkeypatch.setenv("SUPPORT_ALERT_EMAILS", "support@etymos.site, Team@Example.com")
    open_form(env)
    assert [to for to, _ in env.alerts] == ["team@example.com"]


# --- requester views ------------------------------------------------------------------


def test_my_tickets_include_guest_tickets_from_my_address(env):
    open_form(env, as_user=USER)
    open_form(env, email="owner@example.com", subject="Sent before signing in")
    open_form(env, email="someone@example.com")
    env.current["user"] = USER
    items = env.client.get("/api/support/tickets").json()["items"]
    assert sorted(i["number"] for i in items) == [1001, 1002]


def test_other_users_cannot_read_a_ticket(env):
    open_form(env, as_user=USER)
    env.current["user"] = OTHER
    assert env.client.get("/api/support/tickets/1001").status_code == 404
    env.current["user"] = USER
    body = env.client.get("/api/support/tickets/1001").json()
    assert [m["from"] for m in body["messages"]] == ["you"]  # system note hidden


def test_reply_on_site_reopens_and_alerts(env):
    open_form(env, as_user=USER)
    t = tickets(env)[0]
    t["status"] = "pending"
    env.current["user"] = USER
    r = env.client.post("/api/support/tickets/1001/messages", data={"body": "Any news?"})
    assert r.status_code == 200
    assert tickets(env)[0]["status"] == "open"
    assert len(r.json()["messages"]) == 2


def test_closed_ticket_refuses_site_replies(env):
    open_form(env, as_user=USER)
    tickets(env)[0]["status"] = "closed"
    env.current["user"] = USER
    assert env.client.post("/api/support/tickets/1001/messages", data={"body": "hi"}).status_code == 409


def test_guest_link_reads_and_replies(env):
    open_form(env)
    t = tickets(env)[0]
    token = support.guest_token(t["id"])
    env.current["user"] = None
    assert env.client.get(f"/api/support/guest/{token}").json()["number"] == 1001
    assert env.client.post(f"/api/support/guest/{token}/messages", data={"body": "More info"}).status_code == 200
    assert env.client.get("/api/support/guest/" + "0" * 32 + "." + "0" * 40).status_code == 404


# --- admin --------------------------------------------------------------------------


def test_non_admin_is_refused(env):
    env.current["user"] = USER
    assert env.client.get("/api/admin/support/tickets").status_code == 403


def test_admin_reply_is_emailed_threaded_and_sets_pending(env):
    open_form(env, email="guest@example.com")
    ack_id = env.support_sent[0]["message_id"]
    env.current["user"] = ADMIN
    r = env.client.post(
        "/api/admin/support/tickets/1001/messages",
        data={"body": "Refund is on its way."},
        files=[("files", ("receipt.pdf", PDF, "application/pdf"))],
    )
    assert r.status_code == 200, r.text
    reply = env.support_sent[-1]
    assert reply["auto_reply"] is False and reply["references"][-1] == ack_id
    assert reply["attachments"][0].filename == "receipt.pdf"
    t = tickets(env)[0]
    assert t["status"] == "pending" and t["assigned_to"] == ADMIN_ID and t["last_agent_message_at"]
    assert any(m["email_message_id"] == reply["message_id"] for m in messages(env))


def test_internal_note_is_not_emailed(env):
    open_form(env)
    env.current["user"] = ADMIN
    sent_before = len(env.support_sent)
    r = env.client.post("/api/admin/support/tickets/1001/messages", data={"body": "Check SePay", "internal": "true"})
    assert r.status_code == 200 and len(env.support_sent) == sent_before
    assert tickets(env)[0]["status"] == "open"
    env.current["user"] = None
    token = support.guest_token(tickets(env)[0]["id"])
    bodies = [m["body"] for m in env.client.get(f"/api/support/guest/{token}").json()["messages"]]
    assert "Check SePay" not in bodies


def test_failed_email_removes_the_reply(env):
    open_form(env)
    env.current["user"] = ADMIN
    env.fail["support"] = 1
    r = env.client.post("/api/admin/support/tickets/1001/messages", data={"body": "Hello"})
    assert r.status_code == 502 and r.json()["detail"] == "send_failed"
    assert not any(m["body"] == "Hello" for m in messages(env))
    assert tickets(env)[0]["status"] == "open"


def test_admin_list_filters_and_patch(env):
    open_form(env, email="a@example.com", subject="Login broken", category="account")
    open_form(env, email="b@example.com", subject="Report wrong", category="checks")
    env.current["user"] = ADMIN
    items = env.client.get("/api/admin/support/tickets", params={"category": "checks"}).json()["items"]
    assert [i["number"] for i in items] == [1002]
    assert env.client.get("/api/admin/support/tickets", params={"q": "#1001"}).json()["items"][0]["number"] == 1001
    assert env.client.get("/api/admin/support/tickets", params={"q": "login"}).json()["total"] == 1

    r = env.client.patch("/api/admin/support/tickets/1001", json={"status": "resolved", "assigned_to": ADMIN_ID})
    assert r.json()["status"] == "resolved" and r.json()["assignee"]["id"] == ADMIN_ID
    assert env.client.patch("/api/admin/support/tickets/1001", json={"assigned_to": "00000000-0000-4000-8000-000000000009"}).status_code == 400
    summary = env.client.get("/api/admin/support/summary").json()
    assert summary["counts"]["open"] == 1 and summary["counts"]["resolved"] == 1


def test_admin_detail_shows_the_matching_account_for_guest_tickets(env):
    open_form(env, email="owner@example.com")
    env.current["user"] = ADMIN
    detail = env.client.get("/api/admin/support/tickets/1001").json()
    assert detail["identity_verified"] is False
    assert detail["account"]["id"] == "user-1" and detail["account"]["plan_tier"] == "student"


def test_resolved_tickets_close_after_a_week(env):
    open_form(env)
    t = tickets(env)[0]
    t.update(status="resolved", resolved_at=(datetime.now(timezone.utc) - timedelta(days=8)).isoformat())
    assert support.close_stale_resolved(env.db) == 1
    assert tickets(env)[0]["status"] == "closed"


# --- outgoing email -----------------------------------------------------------------


def test_built_message_threads_and_marks_auto_replies(monkeypatch):
    monkeypatch.setenv("SUPPORT_EMAIL", "support@etymos.site")
    from email_templates import support_received_email

    mid = support_mail.new_message_id(1042)
    assert support_mail.OWN_MESSAGE_ID_RE.match(mid).group(1) == "1042"
    msg = support_mail.build_message(
        to="u@example.com",
        content=support_received_email(number=1042, subject="Hi", body="<b>x</b>", view_url=None),
        message_id=mid,
        references=["<a@x>", "<b@y>"],
        auto_reply=True,
        sender_login="noreply@etymos.site",
        from_support_mailbox=False,
        attachments=[support_mail.OutgoingFile("a.pdf", "application/pdf", PDF)],
    )
    assert msg["From"] == "Etymos Support <noreply@etymos.site>"
    assert msg["Reply-To"] == "support@etymos.site"
    assert msg["In-Reply-To"] == "<b@y>" and msg["References"] == "<a@x> <b@y>"
    assert msg["Auto-Submitted"] == "auto-replied"
    html_part = msg.get_body(("html",)).get_content()
    assert "&lt;b&gt;x&lt;/b&gt;" in html_part  # user text is escaped
    assert [p.get_filename() for p in msg.iter_attachments()] == ["a.pdf"]


# --- inbound email ------------------------------------------------------------------


def make_email(
    *, frm="guest@example.com", subject="Re: [#1001] Charged twice", body="Thanks!", in_reply_to=None,
    message_id=None, headers=None, html=None, attachment=None,
) -> bytes:
    msg = EmailMessage()
    msg["From"] = f"Guest <{frm}>"
    msg["To"] = "support@etymos.site"
    msg["Subject"] = subject
    msg["Message-ID"] = message_id or f"<{uuid.uuid4().hex}@mail.example.com>"
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    for k, v in (headers or {}).items():
        msg[k] = v
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    if attachment:
        name, data, ctype = attachment
        maintype, subtype = ctype.split("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return msg.as_bytes()


def gmail_reply(text: str) -> str:
    return (
        f"{text}\n\nOn Wed, Oct 8, 2026 at 9:00 AM Etymos Support <support@etymos.site>\nwrote:\n\n"
        f"> {SUPPORT_REPLY_MARKER}\n> We got your request\n"
    )


def test_strip_reply_handles_common_clients():
    assert support_inbound.strip_reply(gmail_reply("Still broken.")) == "Still broken."
    vi = "Vẫn lỗi ạ.\n\nVào Th 4, 8 thg 10, 2026 lúc 09:00 Etymos Support <support@etymos.site> đã viết:\n> cũ"
    assert support_inbound.strip_reply(vi) == "Vẫn lỗi ạ."
    outlook = "Done, thanks\n\n________________________________\nFrom: Etymos Support <support@etymos.site>\nSent: Wednesday\nSubject: x"
    assert support_inbound.strip_reply(outlook) == "Done, thanks"
    marker = f"Top reply\n\n{SUPPORT_REPLY_MARKER}\nold stuff"
    assert support_inbound.strip_reply(marker) == "Top reply"
    sig = "Here you go\n-- \nLan Nguyen\nUniversity X"
    assert support_inbound.strip_reply(sig) == "Here you go"
    phone = "Ok\n\nSent from my iPhone"
    assert support_inbound.strip_reply(phone) == "Ok"
    only_quote = "> everything quoted"
    assert support_inbound.strip_reply(only_quote) == "> everything quoted"  # never lose a message


def test_html_only_reply_drops_the_gmail_quote():
    raw = make_email(body="", html='<div dir="ltr">New text<br>line 2</div><div class="gmail_quote">On ... wrote: old</div>')
    parsed = support_inbound.parse_email(raw)
    assert support_inbound.strip_reply(parsed.text) == "New text\nline 2"


def test_auto_replies_and_bounces_are_recognised():
    assert support_inbound.parse_email(make_email(headers={"Auto-Submitted": "auto-replied"})).auto_reason
    assert support_inbound.parse_email(make_email(frm="MAILER-DAEMON@mx.example.com")).auto_reason
    assert support_inbound.parse_email(make_email(subject="Out of Office: back Monday")).auto_reason
    assert support_inbound.parse_email(make_email(subject="Trả lời tự động: nghỉ phép")).auto_reason
    assert support_inbound.parse_email(make_email()).auto_reason is None


def test_sender_auth_uses_only_the_top_header():
    raw = make_email(headers={"Authentication-Results": "mx1.onemail.vn; dmarc=pass"})
    assert support_inbound.parse_email(raw).sender_auth == "pass"
    forged = EmailMessage()
    forged["Authentication-Results"] = "mx1.onemail.vn; spf=fail"
    forged["Authentication-Results"] = "evil; dmarc=pass"
    forged["From"] = "a@b.c"
    forged.set_content("x")
    assert support_inbound.parse_email(forged.as_bytes()).sender_auth == "fail"


def _ack_id(env):
    return env.support_sent[0]["message_id"]


def test_reply_to_our_email_is_appended_and_reopens(env):
    open_form(env)
    tickets(env)[0]["status"] = "pending"
    raw = make_email(body=gmail_reply("It's fixed now?"), in_reply_to=_ack_id(env),
                     attachment=("proof.png", PNG, "image/png"))
    assert support_inbound.process(env.db, raw) == "appended"
    t = tickets(env)[0]
    assert t["status"] == "open"
    m = messages(env, t)[-1]
    assert m["body"] == "It's fixed now?" and m["channel"] == "email" and not m["sender_mismatch"]
    assert m["raw_email_path"] in env.db.files
    assert len(env.db.tables["support_attachments"]) == 1
    # The same email again (second poller, retry) is not appended twice.
    assert support_inbound.process(env.db, raw) == "appended"
    assert len(messages(env, t)) == 3  # user, system ack note, reply


def test_reply_from_the_accounts_recovery_address_counts_as_the_requester(env):
    open_form(env, as_user=USER)
    raw = make_email(frm="backup@example.com", body="from my other inbox", in_reply_to=_ack_id(env))
    support_inbound.process(env.db, raw)
    assert messages(env)[-1]["sender_mismatch"] is False


def test_reply_from_a_stranger_is_flagged_and_does_not_reopen(env):
    open_form(env)
    tickets(env)[0]["status"] = "pending"
    raw = make_email(frm="stranger@example.com", in_reply_to=_ack_id(env))
    assert support_inbound.process(env.db, raw) == "appended"
    assert messages(env)[-1]["sender_mismatch"] is True
    assert tickets(env)[0]["status"] == "pending"


def test_subject_tag_only_matches_the_requester(env):
    open_form(env)
    assert support_inbound.process(env.db, make_email(body="by subject")) == "appended"
    assert support_inbound.process(env.db, make_email(frm="stranger@example.com")) == "ticket_created"
    assert len(tickets(env)) == 2 and tickets(env)[1]["requester_email"] == "stranger@example.com"


def test_new_email_opens_a_ticket_and_is_acknowledged(env):
    raw = make_email(frm="new@example.com", subject="Can't log in", body="Help please")
    assert support_inbound.process(env.db, raw) == "ticket_created"
    t = tickets(env)[0]
    assert t["source"] == "email" and t["identity_verified"] is False and t["subject"] == "Can't log in"
    assert env.support_sent[-1]["to"] == "new@example.com"


def test_reply_to_a_closed_ticket_opens_a_linked_one(env):
    open_form(env, as_user=USER)
    tickets(env)[0]["status"] = "closed"
    raw = make_email(frm="owner@example.com", in_reply_to=_ack_id(env), body="Same problem again")
    assert support_inbound.process(env.db, raw) == "ticket_created"
    old, new = tickets(env)
    assert new["previous_ticket_id"] == old["id"] and new["user_id"] == "user-1"
    assert new["identity_verified"] is False


def test_robots_and_our_own_mail_are_ignored(env):
    assert support_inbound.process(env.db, make_email(headers={"Auto-Submitted": "auto-replied"})) == "ignored_auto"
    assert support_inbound.process(env.db, make_email(frm="support@etymos.site")) == "ignored_own"
    assert tickets(env) == []
    assert {r["outcome"] for r in env.db.tables["support_inbound_log"]} == {"ignored_auto", "ignored_own"}


def test_disallowed_email_attachments_are_dropped_with_a_note(env):
    raw = make_email(frm="new@example.com", subject="hi", attachment=("run.exe", b"MZ\x90", "application/octet-stream"))
    support_inbound.process(env.db, raw)
    assert "run.exe" in messages(env)[0]["body"]
    assert env.db.tables.get("support_attachments", []) == []
