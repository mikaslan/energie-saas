#!/usr/bin/env python3
"""Einmalige Provisionierung des Worker-Hosts (Einkaufsliste #2, ADR 0002).

Liest HCLOUD_TOKEN aus .env.local im Repo-Root und legt idempotent an:

  1. SSH-Key  "energie-saas-worker"  (Public Key aus ~/.ssh/energie-saas-worker.pub)
  2. Firewall "worker-fw"            (eingehend NUR 22/tcp, ausgehend frei)
  3. Server   "energie-saas-worker"  (CX33, Ubuntu 24.04, Nürnberg;
                                      8,49 €/M netto + IPv4 0,50 €/M, Stand 2026-08-27)

Ressourcen werden über ihren Namen wiedergefunden — ein zweiter Lauf bestellt
NICHTS doppelt, sondern meldet nur den bestehenden Zustand. Kein Löschpfad:
dieses Skript legt ausschließlich an.
"""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.hetzner.cloud/v1"
REPO_ROOT = Path(__file__).resolve().parents[1]
SSH_PUBKEY = Path.home() / ".ssh" / "energie-saas-worker.pub"


def read_token() -> str:
    env_file = REPO_ROOT / ".env.local"
    if not env_file.exists():
        sys.exit(f"FEHLER: {env_file} fehlt (HCLOUD_TOKEN=... erwartet)")
    for line in env_file.read_text().splitlines():
        if line.startswith("HCLOUD_TOKEN="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"FEHLER: kein HCLOUD_TOKEN in {env_file}")


TOKEN = read_token()


def api(path: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError as err:
        sys.exit(f"FEHLER: HTTP {err.code} bei {path}: {err.read().decode()[:400]}")


def find(collection: str, name: str) -> dict | None:
    items = api(f"/{collection}?name={name}").get(collection, [])
    return items[0] if items else None


def main() -> None:
    # 1. SSH-Key
    key = find("ssh_keys", "energie-saas-worker")
    if key:
        print(f"SSH-Key vorhanden (ID {key['id']})")
    else:
        if not SSH_PUBKEY.exists():
            sys.exit(f"FEHLER: {SSH_PUBKEY} fehlt — erst lokal per ssh-keygen erzeugen")
        key = api("/ssh_keys", {
            "name": "energie-saas-worker",
            "public_key": SSH_PUBKEY.read_text().strip(),
        })["ssh_key"]
        print(f"SSH-Key hinterlegt (ID {key['id']})")

    # 2. Firewall — eingehend nur SSH; keine Outbound-Regeln = ausgehend frei
    fw = find("firewalls", "worker-fw")
    if fw:
        print(f"Firewall vorhanden (ID {fw['id']})")
    else:
        fw = api("/firewalls", {
            "name": "worker-fw",
            "rules": [{
                "direction": "in", "protocol": "tcp", "port": "22",
                "source_ips": ["0.0.0.0/0", "::/0"],
            }],
        })["firewall"]
        print(f"Firewall 'worker-fw' angelegt (ID {fw['id']}) — eingehend nur 22/tcp")

    # 3. Server
    srv = find("servers", "energie-saas-worker")
    if srv:
        print(f"Server vorhanden (ID {srv['id']}, Status {srv['status']}) — nichts bestellt")
    else:
        srv = api("/servers", {
            "name": "energie-saas-worker",
            "server_type": "cx33",
            "image": "ubuntu-24.04",
            "location": "nbg1",
            "ssh_keys": [key["id"]],
            "firewalls": [{"firewall": fw["id"]}],
            "public_net": {"enable_ipv4": True, "enable_ipv6": True},
        })["server"]
        print(f"SERVER BESTELLT: CX33 (ID {srv['id']}) — 8,49 €/M netto + IPv4 0,50 €/M")

    # Auf running warten, damit die IP sicher steht
    for _ in range(60):
        srv = api(f"/servers/{srv['id']}")["server"]
        if srv["status"] == "running":
            break
        time.sleep(5)

    ipv4 = srv["public_net"]["ipv4"]["ip"]
    print(f"Status: {srv['status']}")
    print(f"IPv4:   {ipv4}")
    print(f"IPv6:   {srv['public_net']['ipv6']['ip']}")
    print(f"SSH:    ssh -i ~/.ssh/energie-saas-worker root@{ipv4}")


if __name__ == "__main__":
    main()
