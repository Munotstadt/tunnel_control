# NAS-Seite (Synology)

Zwei Container laufen im selben Compose-Projekt:

| Container | Aufgabe |
|---|---|
| `tunnel-poller` | Fragt alle 30 s `tunnel.munot.app/nas/state` ab, startet/stoppt die `cf-tunnel-*` Container, meldet den Ist-Status zurück |
| `cf-tunnel-nas` | `cloudflared` mit dem Token des Tunnels `nas`. Läuft nur, solange der Poller ihn startet |

Failsafe: Ist der Worker 3 Abfragen in Folge (ca. 90 s) nicht erreichbar oder antwortet fehlerhaft, stoppt der Poller alle Tunnel. `restart: "no"` sorgt dafür, dass nach einem NAS-Neustart alle Tunnel zu bleiben.

## 1. Tunnel in Cloudflare anlegen

Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared. Namen z. B. `nas`. Als Umgebung **Docker** wählen und nur den **Token** kopieren (die lange Zeichenfolge nach `--token`). Unter "Public Hostname" den Dienst festlegen, z. B. `nas.munot.app` auf `http://localhost:5001`.

Hinweis: `network_mode: host` ist gesetzt, damit `localhost` im Tunnel das NAS selbst meint.

Empfehlung: Auch den öffentlichen Hostname mit einer Access-Application (Google-Login) schützen.

## 2. Dateien aufs NAS

Ordner z. B. `/volume1/docker/tunnel_control/` anlegen und diese drei Dateien hineinlegen:
`docker-compose.yml`, `poller.py`, `.env` (aus `.env.example` kopieren).

`.env` ausfüllen:
```
NAS_TOKEN=<gleicher Wert wie das Worker-Secret>
TUNNEL_TOKEN_NAS=<Token des Tunnels nas>
```

## 3. Starten

Container Manager > Projekt > Erstellen > Pfad auf den Ordner wählen > `docker-compose.yml` verwenden > Starten.

Beim ersten Start läuft `cf-tunnel-nas` kurz mit, der Poller stoppt ihn innerhalb von 30 s, weil der Soll-Zustand `off` ist.

Per SSH geht es auch so:
```
cd /volume1/docker/tunnel_control
sudo docker compose up -d
```

## 4. Prüfen

1. `https://tunnel.munot.app` öffnen. Die Karte "NAS" zeigt nach kurzer Zeit "NAS online" und "Ist: gestoppt".
2. Dauer wählen, "Tunnel öffnen" klicken. Innerhalb von 30 s wechselt "Ist" auf "läuft".
3. Log des Pollers: Container Manager > Container > `tunnel-poller` > Protokoll. Erwartet: `START cf-tunnel-nas`, später `STOP cf-tunnel-nas`.

## Weiteren Tunnel hinzufügen

1. In D1: `INSERT INTO tunnel_state (tunnel_id, label) VALUES ('ha', 'Home Assistant');`
2. In `docker-compose.yml` den auskommentierten Block `cf-tunnel-ha` aktivieren, `TUNNEL_TOKEN_HA` in `.env` ergänzen.
3. Projekt neu starten (`docker compose up -d`).

Der Container-Name muss immer `cf-tunnel-<tunnel_id>` lauten.

## Sicherheit

Der Poller bekommt den Docker-Socket und hat damit Root-Rechte auf dem NAS. Das Skript ist kurz (`poller.py`) und nutzt nur die Python-Standardbibliothek. Die Tokens stehen nur in `.env` auf dem NAS, nicht im Repo.
