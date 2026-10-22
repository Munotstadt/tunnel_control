#!/usr/bin/env python3
"""Tunnel-Poller: fragt den Worker ab und startet/stoppt cloudflared-Container.

Nur Python-Standardbibliothek. Docker wird ueber den Unix-Socket angesprochen.
Container-Namen: <CONTAINER_PREFIX><tunnel_id>, z. B. cf-tunnel-nas.

Sicherheit (fail-closed):
  - Tunnel laeuft nur, wenn der Worker 'on' meldet.
  - Ist der Worker FAIL_STOP_AFTER Abfragen in Folge nicht erreichbar oder antwortet
    fehlerhaft, werden alle Tunnel-Container gestoppt.
"""
import datetime
import http.client
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
NAS_TOKEN = os.environ.get("NAS_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
FAIL_STOP_AFTER = int(os.environ.get("FAIL_STOP_AFTER", "3"))
PREFIX = os.environ.get("CONTAINER_PREFIX", "cf-tunnel-")
DOCKER_SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")
USER_AGENT = "tunnel-poller/1.0"


def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {msg}", flush=True)


# ---------------------------------------------------------------- Docker (Unix-Socket)

class _UnixConn(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=30)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect(DOCKER_SOCK)


def docker(method, path):
    conn = _UnixConn()
    try:
        conn.request(method, path)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def container_state(name):
    """True = laeuft, False = gestoppt, None = Container existiert nicht."""
    status, body = docker("GET", f"/containers/{name}/json")
    if status == 404:
        return None
    if status != 200:
        raise RuntimeError(f"docker inspect {name}: HTTP {status}")
    return bool(json.loads(body)["State"]["Running"])


def container_start(name):
    status, _ = docker("POST", f"/containers/{name}/start")
    if status not in (204, 304):
        raise RuntimeError(f"docker start {name}: HTTP {status}")


def container_stop(name):
    status, _ = docker("POST", f"/containers/{name}/stop?t=10")
    if status not in (204, 304):
        raise RuntimeError(f"docker stop {name}: HTTP {status}")


def running_tunnel_containers():
    flt = urllib.parse.quote(json.dumps({"name": [PREFIX]}, separators=(",", ":")))
    status, body = docker("GET", f"/containers/json?filters={flt}")
    if status != 200:
        raise RuntimeError(f"docker list: HTTP {status}")
    names = []
    for c in json.loads(body):
        for n in c.get("Names", []):
            n = n.lstrip("/")
            if n.startswith(PREFIX):
                names.append(n)
    return names


# ---------------------------------------------------------------- Worker-API

def api(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(WORKER_URL + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {NAS_TOKEN}")
    req.add_header("User-Agent", USER_AGENT)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


# ---------------------------------------------------------------- Logik

def reconcile(tunnels):
    """Bringt Container in den Soll-Zustand und liefert die Heartbeat-Liste."""
    report = []
    for t in tunnels:
        tid = t["tunnel_id"]
        name = PREFIX + tid
        want_on = t.get("desired") == "on"
        try:
            running = container_state(name)
            if running is None:
                log(f"WARN {name}: Container existiert nicht (docker compose up -d?)")
                continue
            if want_on and not running:
                log(f"START {name} (bis {t.get('expires_at')})")
                container_start(name)
            elif not want_on and running:
                log(f"STOP  {name}")
                container_stop(name)
            report.append({"tunnel_id": tid, "actual": "running" if container_state(name) else "stopped"})
        except Exception as e:  # einzelner Tunnel darf die Schleife nicht beenden
            log(f"ERROR {name}: {e}")
    return report


def failsafe_stop_all():
    try:
        for name in running_tunnel_containers():
            log(f"FAILSAFE STOP {name}")
            container_stop(name)
    except Exception as e:
        log(f"ERROR failsafe: {e}")


def main():
    if not WORKER_URL or not NAS_TOKEN:
        log("WORKER_URL und NAS_TOKEN muessen gesetzt sein")
        sys.exit(1)
    log(f"Start: {WORKER_URL}, alle {POLL_SECONDS}s, Failsafe nach {FAIL_STOP_AFTER} Fehlern")

    fails = 0
    while True:
        try:
            state = api("GET", "/nas/state")
            tunnels = state["tunnels"]
            if not isinstance(tunnels, list):
                raise ValueError("tunnels ist keine Liste")
            if fails:
                log(f"Worker wieder erreichbar (nach {fails} Fehlern)")
            fails = 0
            report = reconcile(tunnels)
            if report:
                api("POST", "/nas/heartbeat", {"tunnels": report})
        except Exception as e:
            fails += 1
            log(f"WARN Worker-Abfrage fehlgeschlagen ({fails}/{FAIL_STOP_AFTER}): {e}")
            if fails >= FAIL_STOP_AFTER:
                failsafe_stop_all()
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
