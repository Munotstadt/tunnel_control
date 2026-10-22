# tunnel-control

Schalter-Seite für Cloudflare-Tunnel. Browser (Google-Login via Cloudflare Access) setzt den Soll-Zustand, das NAS fragt ihn ab und startet/stoppt `cloudflared`.

| Ressource | Wert |
|---|---|
| Worker | `tunnel-control` |
| Domain | `tunnel.munot.app` |
| D1 | `tunnel_control` (`ff087411-b6f3-4a06-9eb5-a43716564bdd`), Schema bereits eingespielt |
| Startwert | Tunnel `nas` (Label "NAS") |

## 1. Google als Login-Methode (Zero Trust)

1. Google Cloud Console: OAuth-Client (Typ "Webanwendung") anlegen. Redirect-URI: `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback`
2. Zero Trust > Settings > Authentication > Login methods > Add new > Google: Client-ID und Secret eintragen, testen.

## 2. Access-Applications

**App 1: Browser (geschützt)**
- Self-hosted, Domain `tunnel.munot.app`, Pfad leer
- Policy "Allow", Include: Emails = deine Google-Adresse
- Identity providers: nur Google
- Danach den **Application Audience (AUD) Tag** kopieren

**App 2: NAS-Pfad (Bypass)**
- Self-hosted, Domain `tunnel.munot.app`, Pfad `nas/*`
- Policy mit Action **Bypass**, Include: Everyone
- Der spezifischere Pfad gewinnt gegenüber App 1. Der Worker schützt `/nas/*` selbst per Bearer-Token.

## 3. wrangler.toml

`TEAM_DOMAIN` (z. B. `meinteam.cloudflareaccess.com`) und `POLICY_AUD` eintragen. `ALLOWED_EMAILS` optional (zweite Schranke im Worker).

## 4. Deploy

```bash
npx wrangler deploy
openssl rand -hex 32            # Token erzeugen und notieren
npx wrangler secret put NAS_TOKEN
```

Die Custom Domain `tunnel.munot.app` legt Wrangler automatisch an (Zone `munot.app` muss im selben Account liegen).

## 5. Test

```bash
curl -H "Authorization: Bearer $NAS_TOKEN" https://tunnel.munot.app/nas/state
curl -X POST -H "Authorization: Bearer $NAS_TOKEN" -H "Content-Type: application/json" \
  -d '{"tunnels":[{"tunnel_id":"nas","actual":"stopped"}]}' https://tunnel.munot.app/nas/heartbeat
```

Dann `https://tunnel.munot.app` im Browser öffnen: Google-Login, Karte "NAS" mit Schalter.

## API

| Pfad | Auth | Zweck |
|---|---|---|
| `GET /` | Access-JWT | Seite |
| `GET /api/tunnels` | Access-JWT | Zustand + Protokoll |
| `POST /api/toggle` | Access-JWT, Origin-Check | `{tunnel_id, desired: "on"\|"off", minutes?}` |
| `GET /nas/state` | Bearer | `{now, tunnels:[{tunnel_id, desired, expires_at}]}` |
| `POST /nas/heartbeat` | Bearer | `{tunnels:[{tunnel_id, actual: "running"\|"stopped"}]}` |

## Verhalten

- **Auto-Timeout:** Öffnen immer mit Dauer (30 min bis 8 h, Standard 2 h). Danach setzt `/nas/state` den Tunnel auf `off`. Ein "an" ohne Ablaufzeit gibt es nicht.
- **Failsafe fürs NAS-Skript:** Antwortet der Worker nicht oder fehlerhaft, `cloudflared` stoppen.
- **Heartbeat:** Älter als 120 s zeigt die Seite "NAS offline".
- **Neuer Tunnel:** `INSERT INTO tunnel_state (tunnel_id, label) VALUES ('ha', 'Home Assistant');`
- Fehlt `POLICY_AUD`, `TEAM_DOMAIN` oder `NAS_TOKEN`, bleibt der jeweilige Teil gesperrt (fail-closed).
