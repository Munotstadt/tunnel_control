# NAS-Seite (Synology)

Zwei getrennte Compose-Projekte auf dem NAS:

| NAS-Ordner | Repo-Ordner | Container | Aufgabe |
|---|---|---|---|
| `/volume3/docker_v3/tunnel_control` | `nas/tunnel_control/` | `tunnel-poller` | Fragt alle 30 s `tunnel.munot.app/nas/state` ab, startet/stoppt die `cf-tunnel-*` Container, meldet den Ist-Status zurück |
| `/volume3/docker_v3/erp_tunnel` | `nas/erp_tunnel/` | `cf-tunnel-erp`, `erp-app` | `cloudflared` mit dem Token des Tunnels `erp` (läuft nur, solange der Poller ihn startet) und das ERP-Front-End (läuft dauerhaft) |

Failsafe: Ist der Worker 3 Abfragen in Folge (ca. 90 s) nicht erreichbar oder antwortet fehlerhaft, stoppt der Poller alle Tunnel. `restart: "no"` sorgt dafür, dass nach einem NAS-Neustart alle Tunnel zu bleiben.

## 1. Tunnel in Cloudflare anlegen

Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared. Name z. B. `erp`. Als Umgebung **Docker** wählen und nur den **Token** kopieren (die lange Zeichenfolge nach `--token`). Unter "Public Hostname" den Dienst festlegen (Domain und interne Adresse, z. B. `http://localhost:<Port>`).

`network_mode: host` ist gesetzt, damit `localhost` im Tunnel das NAS selbst meint.

Empfehlung: Auch den öffentlichen Hostname mit einer Access-Application (Google-Login) schützen.

## 2. Dateien aufs NAS

**Poller** nach `/volume3/docker_v3/tunnel_control/`:
`docker-compose.yml`, `poller.py`, `.env` (aus `.env.example`)
```
NAS_TOKEN=<gleicher Wert wie das Worker-Secret>
CF_ACCESS_CLIENT_ID=<Client ID des Service Tokens>
CF_ACCESS_CLIENT_SECRET=<Client Secret des Service Tokens>
```
Die beiden `CF_ACCESS_*` Werte sind optional. Sie werden gebraucht, sobald die Access-App für `nas/*` auf Service Auth statt Bypass steht (siehe Haupt-README).

**cloudflared** nach `/volume3/docker_v3/erp_tunnel/`:
`docker-compose.yml`, `.env` (aus `.env.example`)
```
TUNNEL_TOKEN=<Token des Tunnels erp>
```

## 3. Starten

Reihenfolge: zuerst `erp_tunnel`, dann `tunnel_control`.

Container Manager > Projekt > Erstellen > Pfad auf den jeweiligen Ordner > `docker-compose.yml` verwenden > Starten.

Per SSH:
```
cd /volume3/docker_v3/erp_tunnel && sudo docker compose up -d
cd /volume3/docker_v3/tunnel_control && sudo docker compose up -d
```

Beim ersten Start läuft `cf-tunnel-erp` kurz mit, der Poller stoppt ihn innerhalb von 30 s, weil der Soll-Zustand `off` ist. Der Container muss existieren, damit der Poller ihn schalten kann. Fehlt er, steht im Log `Container existiert nicht`.

## 4. Prüfen

1. `https://tunnel.munot.app` öffnen. Die Karte "ERP" zeigt nach kurzer Zeit "NAS online" und "Ist: gestoppt".
2. Dauer wählen, "Tunnel öffnen" klicken. Innerhalb von 30 s wechselt "Ist" auf "läuft".
3. Log des Pollers: Container Manager > Container > `tunnel-poller` > Protokoll. Erwartet: `START cf-tunnel-erp`, später `STOP cf-tunnel-erp`.

## ERP-App im Ordner erp_tunnel

Im Projekt `erp_tunnel` läuft neben `cf-tunnel-erp` der Container `erp-app` (ERP-Front-End, Node/Express). Er läuft dauerhaft, ist aber nur über `127.0.0.1:13000` des NAS erreichbar. Von außen gelangt man nur über den Tunnel hin, solange dieser offen ist.

- Daten: Datenbank `munot_erp` im Container `munot_erp_db` (Projektordner `/volume3/docker_v3/nas_munot_erp`, NAS-IP `192.168.86.30`, Port `5434`). Die Zugangsdaten stehen in `erp_app.env` (Vorlage `erp_app.env.example`).
- Cloudflare: Public Hostname `erp.munot.app` auf `http://localhost:13000`, davor eine Access-Application (Google-Login). Die App selbst hat keinen eigenen Login.
- Schreibschutz: Schreibende Aufrufe (`POST`/`PUT`/`DELETE`) akzeptiert die App nur, wenn der Host `127.0.0.1` oder `localhost` ist. Über `erp.munot.app` ist das ERP daher nur lesbar. Erfassen und Stammdaten ändern geht nur direkt auf dem NAS.
- Start/Update: `cd /volume3/docker_v3/erp_tunnel && sudo docker compose up -d --build --remove-orphans`
- Prüfen auf dem NAS: `curl -s http://127.0.0.1:13000/api/statuses | head -c 200`
- Die Jobs "sync", "valuation" und "backup" auf der Seite Settings sind PowerShell-Skripte für den Windows-PC und laufen im Container nicht.

## Weiteren Tunnel hinzufügen

1. In D1: `INSERT INTO tunnel_state (tunnel_id, label) VALUES ('ha', 'Home Assistant');`
2. Neuen Ordner (z. B. `/volume3/docker_v3/ha_tunnel`) mit einer Kopie von `erp_tunnel/docker-compose.yml` anlegen. Service- und Container-Namen auf `cf-tunnel-ha` ändern, eigene `.env` mit dem Token.
3. `docker compose up -d`. Am Poller ändert sich nichts.

Der Container-Name muss immer `cf-tunnel-<tunnel_id>` lauten.

## Sicherheit

Der Poller bekommt den Docker-Socket und hat damit Root-Rechte auf dem NAS. Das Skript ist kurz (`poller.py`) und nutzt nur die Python-Standardbibliothek. Die Tokens stehen nur in den `.env`-Dateien auf dem NAS, nicht im Repo.
