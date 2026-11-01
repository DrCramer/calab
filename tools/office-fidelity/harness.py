#!/usr/bin/env python3
"""Storage + callback stub next to a remote Document Server (ADR-0143 trial): runs in a container on
the Document Server's Docker network, so the server reaches it by name and nothing listens
publicly. Stdlib only.

  env JWT_SECRET (the Document Server's), DATA (fixtures in DATA, saved files to DATA/saved),
      DS_INTERNAL (how this container reaches the Document Server, e.g. http://onlyoffice-trial-ds)

  GET  /files/<name>       the fixture (the Document Server's JWT «download» is verified when sent)
  POST /callback/<name>    verifies the JWT (header with payload, or token in the body); status 2/6:
                           downloads the saved file (origin rewritten to DS_INTERNAL) to
                           DATA/saved/editor<status>-<name>; answers {"error":0}
  GET  /callbacks          the callbacks so far (JSON); GET /saved/<file> a saved file
"""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ["JWT_SECRET"].encode()
DATA = os.environ.get("DATA", "/data")
DS_INTERNAL = os.environ.get("DS_INTERNAL", "http://onlyoffice-trial-ds").rstrip("/")
CALLBACKS = []


def verify(tok):
    h, p, s = tok.split(".")
    want = base64.urlsafe_b64encode(hmac.new(SECRET, f"{h}.{p}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    if not hmac.compare_digest(want, s):
        raise ValueError("bad signature")
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        print(time.strftime("%H:%M:%S"), self.command, self.path.split("?")[0], fmt % a, flush=True)

    def send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def bearer(self):
        a = self.headers.get("Authorization", "")
        return a[7:] if a.lower().startswith("bearer ") else ""

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        try:
            if path.startswith("/files/"):
                if self.bearer():
                    verify(self.bearer())
                with open(os.path.join(DATA, os.path.basename(path[7:])), "rb") as f:
                    return self.send(200, f.read(), "application/octet-stream")
            if path == "/callbacks":
                return self.send(200, json.dumps(CALLBACKS))
            if path.startswith("/saved/"):
                with open(os.path.join(DATA, "saved", os.path.basename(path[7:])), "rb") as f:
                    return self.send(200, f.read(), "application/octet-stream")
            self.send(404, "{}")
        except Exception as e:  # noqa: BLE001
            self.send(500, json.dumps({"err": str(e)}))

    def do_POST(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0) or 0)
        try:
            if not path.startswith("/callback/"):
                return self.send(404, "{}")
            name = os.path.basename(path[10:])
            body = json.loads(raw or b"{}")
            claims = verify(self.bearer()) if self.bearer() else verify(body["token"])
            signed = claims.get("payload", claims)
            cb = {"name": name, "status": signed.get("status"), "at": time.time(), "users": signed.get("users"),
                  "forcesavetype": signed.get("forcesavetype"), "operation": claims.get("operation"), "filetype": signed.get("filetype")}
            if signed.get("status") in (2, 6) and signed.get("url"):
                u = urllib.parse.urlparse(signed["url"])
                src = DS_INTERNAL + u.path + ("?" + u.query if u.query else "")
                t0 = time.time()
                data = urllib.request.urlopen(src, timeout=60).read()
                os.makedirs(os.path.join(DATA, "saved"), exist_ok=True)
                out = f"editor{signed['status']}-{name}"
                with open(os.path.join(DATA, "saved", out), "wb") as f:
                    f.write(data)
                cb.update(file=out, size=len(data), sha256=hashlib.sha256(data).hexdigest(), download_s=round(time.time() - t0, 2))
            CALLBACKS.append(cb)
            print("callback", json.dumps(cb, ensure_ascii=False), flush=True)
            self.send(200, '{"error":0}')
        except Exception as e:  # noqa: BLE001
            print("callback error", e, flush=True)
            self.send(200, '{"error":1}')


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), H).serve_forever()
