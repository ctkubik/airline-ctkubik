"""A tiny fake airline website for the loyalty sync end-to-end test.

Home page with a Sign in link, a two-step sign-in (username, then password),
a verification-code page, and an account page with the balance. Signed-in
state is a cookie, like the real thing.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

USERNAME = "chad@example.com"
PASSWORD = "correct horse"
CODE = "123456"

PAGE = "<!doctype html><html><body>{body}</body></html>"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # noqa: ANN002
        pass

    def _send(self, body: str, status: int = 200, headers: dict | None = None) -> None:
        data = PAGE.format(body=body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, to: str, cookie: str | None = None) -> None:
        self.send_response(303)
        self.send_header("Location", to)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _signed_in(self) -> bool:
        return "session=ok" in (self.headers.get("Cookie") or "")

    def _form(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}

    def do_GET(self) -> None:
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/":
            if self._signed_in():
                self._send(
                    '<header>Hi Chad <a href="/account">My account</a></header>'
                    "<p>Earn 60,000 bonus miles with our card.</p>"
                )
            else:
                self._send(
                    '<header><a href="/login">Sign in</a></header>'
                    "<p>Earn 60,000 bonus miles with our card. "
                    "Reach Gold Medallion status faster.</p>"
                )
        elif url.path == "/login":
            self._send(
                '<h1>Sign in</h1><form action="/password" method="get">'
                '<label for="loginId">SkyMiles # or username</label>'
                '<input id="loginId" name="loginId" type="text">'
                "<button type=submit>Continue</button></form>"
            )
        elif url.path == "/password":
            self._send(
                f'<h1>Welcome back</h1><form action="/password" method="post">'
                f'<input type="hidden" name="loginId" value="{query.get("loginId", "")}">'
                '<input name="pw" type="password"><button type=submit>Log in</button></form>'
            )
        elif url.path == "/verify":
            self._send(
                "<h1>Verify it's you</h1><p>We sent a 6-digit code to c***@example.com.</p>"
                '<form action="/verify" method="post"><input name="otpCode" type="text">'
                '<label><input type="checkbox" id="rememberDevice" name="remember">'
                " Remember this device</label>"
                "<button type=submit>Verify</button></form>"
            )
        elif url.path == "/account":
            if not self._signed_in():
                return self._redirect("/login")
            self._send(
                "<h1>My SkyMiles</h1><div>SkyMiles balance</div><div>123,456 miles</div>"
                "<div>Status: Gold Medallion Member</div><div>MQDs $4,200 of $10,000</div>"
            )
        else:
            self._send("Not found", 404)

    def do_POST(self) -> None:
        form = self._form()
        if self.path == "/password":
            if form.get("loginId") == USERNAME and form.get("pw") == PASSWORD:
                return self._redirect("/verify")
            self._send(
                "<p>The password you entered is incorrect.</p>"
                '<form action="/password" method="post">'
                '<input name="pw" type="password"><button type=submit>Log in</button></form>'
            )
        elif self.path == "/verify":
            if form.get("otpCode") == CODE:
                return self._redirect("/", cookie="session=ok; Path=/; Max-Age=86400")
            self._send("<p>That code didn't work.</p><input name=otpCode>")
        else:
            self._send("Not found", 404)


def start() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"
