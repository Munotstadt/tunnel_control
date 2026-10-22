// tunnel-control: Schalter fuer Cloudflare-Tunnel (Browser) + Abfrage-API fuer das NAS.
//
// Browser   : https://tunnel.munot.app/            -> Cloudflare Access (Google) + JWT-Pruefung im Worker
// NAS       : https://tunnel.munot.app/nas/*       -> Bearer-Token (NAS_TOKEN), in Access per Bypass-Policy freigegeben
//
// Sicherheit: Fail-closed. Fehlt eine Konfiguration (POLICY_AUD, TEAM_DOMAIN, NAS_TOKEN), wird nichts freigegeben.

const ALLOWED_MINUTES = [30, 60, 120, 240, 480];
const HEARTBEAT_STALE_S = 120;

const baseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...baseHeaders, 'content-type': 'application/json; charset=utf-8' },
  });

const text = (msg, status) =>
  new Response(msg, { status, headers: { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' } });

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- Auth: Cloudflare Access JWT

const td = new TextDecoder();
const te = new TextEncoder();

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Uint8Array.from(atob(s + pad), (c) => c.charCodeAt(0));
}

let jwksCache = { keys: null, at: 0 };

async function getJwks(env, force = false) {
  if (!force && jwksCache.keys && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('jwks fetch failed');
  const { keys } = await res.json();
  jwksCache = { keys, at: Date.now() };
  return keys;
}

async function verifyAccessJwt(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(td.decode(b64urlToBytes(parts[0])));
    if (header.alg !== 'RS256' || !header.kid) return null;

    let jwk = (await getJwks(env)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await getJwks(env, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      te.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;

    const p = JSON.parse(td.decode(b64urlToBytes(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (typeof p.exp !== 'number' || p.exp <= now) return null;
    if (typeof p.nbf === 'number' && p.nbf > now + 60) return null;
    if (p.iss !== `https://${env.TEAM_DOMAIN}`) return null;
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(env.POLICY_AUD)) return null;

    const email = String(p.email || '').toLowerCase();
    if (!email) return null;
    const allowed = String(env.ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(email)) return null;

    return { email };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Auth: NAS-Bearer

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
}

async function checkBearer(request, env) {
  if (!env.NAS_TOKEN) return false;
  const m = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return false;
  const [a, b] = await Promise.all([sha256(m[1]), sha256(env.NAS_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- Daten

// Abgelaufene Tunnel schliessen (lazy, bei jedem Zugriff).
async function expireDue(env) {
  const now = nowIso();
  const due = await env.DB.prepare(
    "SELECT tunnel_id FROM tunnel_state WHERE desired = 'on' AND (expires_at IS NULL OR expires_at <= ?)",
  )
    .bind(now)
    .all();
  for (const r of due.results) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE tunnel_state SET desired = 'off', expires_at = NULL, updated_at = ?, updated_by = 'auto-timeout' WHERE tunnel_id = ? AND desired = 'on'",
      ).bind(now, r.tunnel_id),
      env.DB.prepare(
        "INSERT INTO tunnel_log (tunnel_id, event, actor, detail) VALUES (?, 'expired', 'system', 'Auto-Timeout')",
      ).bind(r.tunnel_id),
    ]);
  }
}

async function listTunnels(env) {
  const { results } = await env.DB.prepare(
    'SELECT tunnel_id, label, desired, expires_at, auto_off_minutes, actual, last_heartbeat, updated_at, updated_by FROM tunnel_state ORDER BY label',
  ).all();
  return results;
}

async function listLog(env, limit = 15) {
  const { results } = await env.DB.prepare(
    'SELECT ts, tunnel_id, event, actor, detail FROM tunnel_log ORDER BY id DESC LIMIT ?',
  )
    .bind(limit)
    .all();
  return results;
}

// ---------------------------------------------------------------- NAS-Endpunkte

async function handleNas(request, env, url) {
  if (!(await checkBearer(request, env))) return text('Unauthorized', 401);

  if (url.pathname === '/nas/state' && request.method === 'GET') {
    await expireDue(env);
    const tunnels = (await listTunnels(env)).map((t) => ({
      tunnel_id: t.tunnel_id,
      desired: t.desired,
      expires_at: t.expires_at,
    }));
    return json({ now: nowIso(), tunnels });
  }

  if (url.pathname === '/nas/heartbeat' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.tunnels)) return json({ error: 'tunnels[] erwartet' }, 400);

    const now = nowIso();
    for (const item of body.tunnels) {
      if (!item || typeof item.tunnel_id !== 'string') continue;
      if (!['running', 'stopped'].includes(item.actual)) continue;
      const prev = await env.DB.prepare('SELECT actual FROM tunnel_state WHERE tunnel_id = ?')
        .bind(item.tunnel_id)
        .first();
      if (!prev) continue;
      const stmts = [
        env.DB.prepare('UPDATE tunnel_state SET actual = ?, last_heartbeat = ? WHERE tunnel_id = ?').bind(
          item.actual,
          now,
          item.tunnel_id,
        ),
      ];
      if (prev.actual !== item.actual) {
        stmts.push(
          env.DB.prepare(
            "INSERT INTO tunnel_log (tunnel_id, event, actor, detail) VALUES (?, 'status', 'nas', ?)",
          ).bind(item.tunnel_id, `${prev.actual} -> ${item.actual}`),
        );
      }
      await env.DB.batch(stmts);
    }
    return json({ ok: true });
  }

  return text('Not found', 404);
}

// ---------------------------------------------------------------- Browser-Endpunkte

async function handleApi(request, env, url, user) {
  if (url.pathname === '/api/tunnels' && request.method === 'GET') {
    await expireDue(env);
    return json({
      now: nowIso(),
      user: user.email,
      stale_after_s: HEARTBEAT_STALE_S,
      allowed_minutes: ALLOWED_MINUTES,
      tunnels: await listTunnels(env),
      log: await listLog(env),
    });
  }

  if (url.pathname === '/api/toggle' && request.method === 'POST') {
    // CSRF-Schutz: gleiche Origin + JSON
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Origin' }, 403);
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
      return json({ error: 'Content-Type' }, 415);
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body.tunnel_id !== 'string' || !['on', 'off'].includes(body.desired)) {
      return json({ error: 'tunnel_id und desired (on|off) erwartet' }, 400);
    }
    const row = await env.DB.prepare('SELECT tunnel_id, auto_off_minutes FROM tunnel_state WHERE tunnel_id = ?')
      .bind(body.tunnel_id)
      .first();
    if (!row) return json({ error: 'Tunnel unbekannt' }, 404);

    const now = nowIso();
    let expires = null;
    let minutes = null;
    if (body.desired === 'on') {
      minutes = ALLOWED_MINUTES.includes(body.minutes) ? body.minutes : row.auto_off_minutes;
      expires = new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE tunnel_state SET desired = ?, expires_at = ?, updated_at = ?, updated_by = ? WHERE tunnel_id = ?',
      ).bind(body.desired, expires, now, user.email, body.tunnel_id),
      env.DB.prepare('INSERT INTO tunnel_log (tunnel_id, event, actor, detail) VALUES (?, ?, ?, ?)').bind(
        body.tunnel_id,
        body.desired,
        user.email,
        minutes ? `Dauer ${minutes} min` : null,
      ),
    ]);
    return json({ ok: true });
  }

  return text('Not found', 404);
}

// ---------------------------------------------------------------- Seite

function page(nonce) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Tunnel Control</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--text:#1f1f1d;--muted:#6b6a65;--line:#e1dfd6;--on:#1d7a4f;--on-bg:#e3f3ea;--off:#5f5e5a;--off-bg:#eceae2;--warn:#8a5a0b;--warn-bg:#faeeda;--btn:#1f1f1d;--btn-text:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#222220;--text:#efeee9;--muted:#9c9a92;--line:#34332f;--on:#6fd1a0;--on-bg:#173a2a;--off:#b4b2a9;--off-bg:#2e2d2a;--warn:#f0c070;--warn-bg:#3d2f12;--btn:#efeee9;--btn-text:#161614}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px}
h1{font-size:22px;font-weight:500;margin:0}
h2{font-size:18px;font-weight:500;margin:0}
.muted{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.pill{font-size:13px;padding:2px 10px;border-radius:999px;background:var(--off-bg);color:var(--off)}
.pill.on{background:var(--on-bg);color:var(--on)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.ctl{display:flex;gap:8px;margin-top:12px}
button,select{font:inherit;border-radius:8px;border:1px solid var(--line);padding:10px 14px;background:var(--card);color:var(--text)}
button{flex:1;background:var(--btn);color:var(--btn-text);border-color:var(--btn);cursor:pointer;font-weight:500}
button.stop{background:transparent;color:var(--text);border-color:var(--text)}
button:disabled{opacity:.5;cursor:default}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:6px 4px;border-top:1px solid var(--line);vertical-align:top}
td:first-child{white-space:nowrap;color:var(--muted)}
#err{color:var(--warn);font-size:14px;margin-bottom:8px;min-height:20px}
</style>
</head>
<body>
<main>
<header><h1>Tunnel Control</h1><span class="muted" id="user"></span></header>
<div id="err" role="alert"></div>
<div id="tunnels"></div>
<h2 style="margin:20px 0 8px">Protokoll</h2>
<div class="card"><table><tbody id="log"></tbody></table></div>
</main>
<script nonce="${nonce}">
const $ = (id) => document.getElementById(id);
const DUR = { 30: '30 min', 60: '1 h', 120: '2 h', 240: '4 h', 480: '8 h' };
const EVENT = { on: 'geöffnet', off: 'geschlossen', expired: 'Auto-Timeout', status: 'NAS-Status' };
const chosen = {};
let data = null;
let busy = false;

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}
function pill(txt, cls) { return el('span', 'pill' + (cls ? ' ' + cls : ''), txt); }
function fmtRemaining(iso, now) {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.parse(now)) / 60000));
  return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
}
function fmtTs(iso) {
  return new Date(iso).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function setErr(msg) { $('err').textContent = msg || ''; }

async function call(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error('Fehler ' + res.status);
  return res.json();
}

function render() {
  if (!data) return;
  if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
  $('user').textContent = data.user;
  const box = $('tunnels');
  box.replaceChildren();
  for (const t of data.tunnels) {
    const age = t.last_heartbeat ? (Date.parse(data.now) - Date.parse(t.last_heartbeat)) / 1000 : Infinity;
    const nasOnline = age <= data.stale_after_s;
    const actual = nasOnline ? t.actual : 'unknown';
    const isOn = t.desired === 'on';

    const card = el('div', 'card');
    card.appendChild(el('h2', '', t.label));
    const row = el('div', 'row');
    row.appendChild(pill('Soll: ' + (isOn ? 'an' : 'aus'), isOn ? 'on' : ''));
    row.appendChild(pill('Ist: ' + (actual === 'running' ? 'läuft' : actual === 'stopped' ? 'gestoppt' : 'unbekannt'), actual === 'running' ? 'on' : ''));
    row.appendChild(pill(nasOnline ? 'NAS online' : 'NAS offline', nasOnline ? '' : 'warn'));
    card.appendChild(row);

    if (isOn && t.expires_at) card.appendChild(el('div', 'muted', 'Schliesst automatisch in ' + fmtRemaining(t.expires_at, data.now)));
    if ((isOn && actual !== 'running') || (!isOn && actual === 'running')) card.appendChild(el('div', 'muted', 'Warte auf NAS …'));

    const ctl = el('div', 'ctl');
    let sel = null;
    if (!isOn) {
      sel = el('select');
      sel.setAttribute('aria-label', 'Dauer');
      for (const m of data.allowed_minutes) {
        const o = el('option', '', DUR[m] || m + ' min');
        o.value = m;
        if (m === (chosen[t.tunnel_id] || t.auto_off_minutes)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { chosen[t.tunnel_id] = Number(sel.value); });
      ctl.appendChild(sel);
    }
    const btn = el('button', isOn ? 'stop' : '', isOn ? 'Tunnel schliessen' : 'Tunnel öffnen');
    btn.disabled = busy;
    btn.addEventListener('click', () => toggle(t.tunnel_id, isOn ? 'off' : 'on', sel ? Number(sel.value) : undefined));
    ctl.appendChild(btn);
    card.appendChild(ctl);
    box.appendChild(card);
  }

  const log = $('log');
  log.replaceChildren();
  const labels = Object.fromEntries(data.tunnels.map((t) => [t.tunnel_id, t.label]));
  for (const l of data.log) {
    const tr = el('tr');
    tr.appendChild(el('td', '', fmtTs(l.ts)));
    const parts = [labels[l.tunnel_id] || l.tunnel_id, EVENT[l.event] || l.event];
    if (l.detail) parts.push(l.detail);
    if (l.actor && l.actor !== 'system') parts.push(l.actor);
    tr.appendChild(el('td', '', parts.join(' · ')));
    log.appendChild(tr);
  }
}

async function load() {
  try {
    data = await call('/api/tunnels');
    setErr('');
    render();
  } catch (e) {
    setErr('Laden fehlgeschlagen. Seite neu laden, falls die Sitzung abgelaufen ist.');
  }
}

async function toggle(tunnel_id, desired, minutes) {
  busy = true;
  render();
  try {
    await call('/api/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tunnel_id, desired, minutes }),
    });
    setErr('');
  } catch (e) {
    setErr('Schalten fehlgeschlagen: ' + e.message);
  }
  busy = false;
  await load();
}

load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- Router

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/nas/')) return await handleNas(request, env, url);

      if (!env.POLICY_AUD || !env.TEAM_DOMAIN) return text('Access nicht konfiguriert', 503);
      const user = await verifyAccessJwt(request, env);
      if (!user) return text('Unauthorized', 401);

      if (url.pathname === '/' && request.method === 'GET') {
        const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        return new Response(page(nonce), {
          headers: {
            ...baseHeaders,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            'x-frame-options': 'DENY',
          },
        });
      }

      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url, user);

      return text('Not found', 404);
    } catch (e) {
      console.error(e);
      return text('Internal error', 500);
    }
  },
};
