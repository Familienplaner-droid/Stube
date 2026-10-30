// Stube – Familien-Server (Cloudflare Worker + Durable Object)
//
// Speichert Einstellungen, Profile, Chats, Medien und Verbrauch der Familie,
// leitet Anfragen an KI-Anbieter weiter (die API-Schlüssel bleiben hier auf dem Server)
// und lässt lange Antworten im Hintergrund weiterlaufen, auch wenn ein Handy die Verbindung verliert.
//
// Alles läuft in genau einem Durable Object („family“) mit eigener SQLite-Datenbank.

import { DurableObject } from "cloudflare:workers";

const VERSION = 1;
const CHUNK = 900000;               // Zeichen pro Datenbankzeile (Grenze: 2 MB pro Zeile)
const JOB_KEEP_MS = 3 * 864e5;      // Hintergrund-Aufträge 3 Tage aufbewahren

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,HEAD,OPTIONS",
  "access-control-allow-headers": "content-type,x-stube-key,x-stube-admin,x-profile,x-month,anthropic-version,anthropic-beta,anthropic-dangerous-direct-browser-access,authorization,x-api-key",
  "access-control-expose-headers": "x-stube-version",
  "access-control-max-age": "86400",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "x-stube-version": String(VERSION) } });
const err = (status, message) => json({ error: { message, stube: true } }, status);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "") return new Response("Stube-Server läuft. Diese Adresse in der Stube-App unter Einstellungen → Familien-Server eintragen.", { headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
    if (!url.pathname.startsWith("/api/")) return err(404, "Nicht gefunden");
    const stub = env.FAMILY.get(env.FAMILY.idFromName("family"));
    return stub.fetch(req);
  },
};

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function eqConst(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export class Family extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.jobs = new Map();   // laufende Aufträge im Arbeitsspeicher
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS docs (k TEXT, part INTEGER, v TEXT, updated INTEGER, PRIMARY KEY (k, part));
      CREATE TABLE IF NOT EXISTS chats (pid TEXT, id TEXT, updated INTEGER, deleted INTEGER DEFAULT 0, parts INTEGER DEFAULT 0, PRIMARY KEY (pid, id));
      CREATE TABLE IF NOT EXISTS media (h TEXT, part INTEGER, v TEXT, PRIMARY KEY (h, part));
      CREATE TABLE IF NOT EXISTS usage (pid TEXT, month TEXT, tin INTEGER, tout INTEGER, cost REAL, n INTEGER, PRIMARY KEY (pid, month));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, pid TEXT, chat TEXT, created INTEGER, status INTEGER, done INTEGER DEFAULT 0, error TEXT, meta TEXT);
      CREATE TABLE IF NOT EXISTS job_events (id TEXT, seq INTEGER, data TEXT, PRIMARY KEY (id, seq));
    `);
  }

  /* ---------- kleine Datenbank-Helfer ---------- */
  meta(k) { const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v); }
  getDoc(k) {
    const rows = this.sql.exec("SELECT v, updated FROM docs WHERE k = ? ORDER BY part", k).toArray();
    if (!rows.length) return null;
    return { value: JSON.parse(rows.map(r => r.v).join("")), updated: rows[0].updated };
  }
  putDoc(k, value, updated = Date.now()) {
    const s = JSON.stringify(value);
    this.sql.exec("DELETE FROM docs WHERE k = ?", k);
    for (let i = 0, p = 0; i < s.length || p === 0; i += CHUNK, p++) this.sql.exec("INSERT INTO docs (k, part, v, updated) VALUES (?, ?, ?, ?)", k, p, s.slice(i, i + CHUNK), updated);
  }

  /* ---------- Anmeldung ---------- */
  async auth(req) {
    const fam = this.meta("famHash"); if (!fam) return { ok: false, setup: false };
    const salt = this.meta("salt");
    const key = req.headers.get("x-stube-key") || "";
    const ok = eqConst(await sha256(salt + ":" + key), fam);
    let admin = false;
    const ak = req.headers.get("x-stube-admin");
    if (ok && ak) admin = eqConst(await sha256(salt + ":admin:" + ak), this.meta("adminHash") || "");
    return { ok, admin, setup: true };
  }

  settingsPublic() {
    const d = this.getDoc("settings"); if (!d) return null;
    const s = d.value;
    (s.providers || []).forEach(p => { p.hasKey = !!p.apiKey; p.apiKey = ""; });
    return s;
  }
  usageAll() {
    const out = {};
    for (const r of this.sql.exec("SELECT * FROM usage").toArray()) {
      (out[r.pid] = out[r.pid] || {})[r.month] = { in: r.tin, out: r.tout, cost: r.cost, n: r.n };
    }
    return out;
  }
  budgetProblem(pid, month) {
    if (!pid) return null;
    if (!/^\d{4}-\d{2}$/.test(month || "")) month = monthKey();
    const profs = (this.getDoc("profiles") || {}).value || [];
    const p = profs.find(x => x.id === pid);
    if (!p || !(+p.limit > 0)) return null;
    const r = this.sql.exec("SELECT cost FROM usage WHERE pid = ? AND month = ?", pid, month).toArray()[0];
    const spent = r ? r.cost : 0;
    return spent >= +p.limit ? `Das Monatsbudget von ${(+p.limit).toFixed(2).replace(".", ",")} $ ist aufgebraucht.` : null;
  }
  provider(id) {
    const d = this.getDoc("settings");
    return d && (d.value.providers || []).find(p => p.id === id);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "");
    try {
      if (path === "/hello") return json({ stube: true, version: VERSION, setup: !!this.meta("famHash") });
      if (path === "/setup" && req.method === "POST") {
        if (this.meta("famHash")) return err(409, "Der Server ist bereits eingerichtet.");
        const b = await req.json();
        if (!b.familyPass || String(b.familyPass).length < 8 || !b.adminPass || String(b.adminPass).length < 8) return err(400, "Beide Passwörter brauchen mindestens 8 Zeichen.");
        if (b.familyPass === b.adminPass) return err(400, "Familien- und Admin-Passwort müssen sich unterscheiden.");
        const salt = crypto.randomUUID();
        this.setMeta("salt", salt);
        this.setMeta("famHash", await sha256(salt + ":" + b.familyPass));
        this.setMeta("adminHash", await sha256(salt + ":admin:" + b.adminPass));
        return json({ ok: true });
      }
      const a = await this.auth(req);
      if (!a.setup) return err(428, "Der Server ist noch nicht eingerichtet.");
      if (!a.ok) return err(401, "Das Familien-Passwort stimmt nicht.");

      if (path === "/check") return json({ ok: true, admin: a.admin });
      if (path === "/state" && req.method === "GET") return json({ settings: this.settingsPublic(), profiles: (this.getDoc("profiles") || {}).value || null, usage: this.usageAll(), admin: a.admin });
      if (path === "/usage" && req.method === "GET") return json({ usage: this.usageAll() });
      if (path === "/usage" && req.method === "POST") {
        const b = await req.json();
        if (!b.pid || !b.month) return err(400, "Angaben fehlen.");
        const n = b.n != null ? Math.max(0, Math.round(+b.n || 0)) : 1;
        this.sql.exec(`INSERT INTO usage (pid, month, tin, tout, cost, n) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (pid, month) DO UPDATE SET tin = tin + excluded.tin, tout = tout + excluded.tout, cost = cost + excluded.cost, n = n + excluded.n`,
          b.pid, b.month, Math.round(+b.in || 0), Math.round(+b.out || 0), Math.max(0, +b.cost || 0), n);
        return json({ usage: this.usageAll() });
      }
      if (path === "/settings" && req.method === "PUT") {
        if (!a.admin) return err(403, "Dafür ist das Admin-Passwort nötig.");
        const s = await req.json();
        const old = (this.getDoc("settings") || {}).value || { providers: [] };
        for (const p of s.providers || []) {
          const o = (old.providers || []).find(x => x.id === p.id);
          if (!p.apiKey && o && o.apiKey && !p.clearKey) p.apiKey = o.apiKey;   // vorhandenen Schlüssel behalten
          delete p.hasKey; delete p.clearKey;
        }
        this.putDoc("settings", s);
        return json({ ok: true, settings: this.settingsPublic() });
      }
      if (path === "/profiles" && req.method === "PUT") {
        if (!a.admin) return err(403, "Dafür ist das Admin-Passwort nötig.");
        this.putDoc("profiles", await req.json());
        return json({ ok: true });
      }

      /* ----- Chats ----- */
      if (path === "/chats" && req.method === "GET") {
        const pid = url.searchParams.get("pid");
        return json({ chats: this.sql.exec("SELECT id, updated, deleted FROM chats WHERE pid = ?", pid).toArray() });
      }
      if (path === "/chat") {
        const pid = url.searchParams.get("pid"), id = url.searchParams.get("id");
        if (!pid || !id) return err(400, "Angaben fehlen.");
        const key = `chat:${pid}:${id}`;
        if (req.method === "GET") { const d = this.getDoc(key); return d ? json({ chat: d.value, updated: d.updated }) : err(404, "Chat nicht gefunden."); }
        if (req.method === "PUT") {
          const b = await req.json(); const up = +b.updated || Date.now();
          const r = this.sql.exec("SELECT updated FROM chats WHERE pid = ? AND id = ?", pid, id).toArray()[0];
          if (r && r.updated > up) return json({ ok: false, newer: true, updated: r.updated });
          this.putDoc(key, b.chat, up);
          this.sql.exec("INSERT OR REPLACE INTO chats (pid, id, updated, deleted) VALUES (?, ?, ?, 0)", pid, id, up);
          return json({ ok: true });
        }
        if (req.method === "DELETE") {
          this.sql.exec("DELETE FROM docs WHERE k = ?", key);
          this.sql.exec("INSERT OR REPLACE INTO chats (pid, id, updated, deleted) VALUES (?, ?, ?, 1)", pid, id, Date.now());
          return json({ ok: true });
        }
      }

      /* ----- Medien (Bilder, Videos, Musik, Dateien) ----- */
      const mm = path.match(/^\/media\/([a-f0-9]{64})$/);
      if (mm) {
        const h = mm[1];
        if (req.method === "HEAD" || (req.method === "GET" && url.searchParams.has("exists"))) {
          const r = this.sql.exec("SELECT COUNT(*) AS n FROM media WHERE h = ?", h).toArray()[0];
          return req.method === "HEAD" ? new Response(null, { status: r.n ? 200 : 404, headers: CORS }) : json({ exists: !!r.n });
        }
        if (req.method === "GET") {
          const rows = this.sql.exec("SELECT v FROM media WHERE h = ? ORDER BY part", h).toArray();
          if (!rows.length) return err(404, "Datei nicht gefunden.");
          return new Response(rows.map(r => r.v).join(""), { headers: { ...CORS, "content-type": "text/plain", "cache-control": "private, max-age=31536000, immutable" } });
        }
        if (req.method === "PUT") {
          const text = await req.text();
          if (await sha256(text) !== h) return err(400, "Prüfsumme stimmt nicht.");
          this.sql.exec("DELETE FROM media WHERE h = ?", h);
          for (let i = 0, p = 0; i < text.length || p === 0; i += CHUNK, p++) this.sql.exec("INSERT INTO media (h, part, v) VALUES (?, ?, ?)", h, p, text.slice(i, i + CHUNK));
          return json({ ok: true });
        }
      }

      /* ----- Weiterleitung an Anbieter ----- */
      const pm = path.match(/^\/proxy\/([^/]+)(\/.*)$/);
      if (pm) {
        const prob = this.budgetProblem(req.headers.get("x-profile"), req.headers.get("x-month"));
        if (prob && req.method === "POST") return err(402, prob);
        return this.forward(pm[1], pm[2] + url.search, req);
      }

      /* ----- Hintergrund-Aufträge ----- */
      if (path === "/jobs" && req.method === "POST") {
        const b = await req.json();
        const prob = this.budgetProblem(b.pid, b.month);
        if (prob) return err(402, prob);
        return json({ id: await this.startJob(b) });
      }
      if (path === "/jobs" && req.method === "GET") {
        const pid = url.searchParams.get("pid");
        return json({ jobs: this.sql.exec("SELECT id, chat, created, status, done, meta FROM jobs WHERE pid = ? ORDER BY created", pid).toArray() });
      }
      const jm = path.match(/^\/jobs\/([A-Za-z0-9-]+)$/);
      if (jm) {
        if (req.method === "GET") return this.pollJob(jm[1], +url.searchParams.get("from") || 0);
        if (req.method === "DELETE") {
          const j = this.jobs.get(jm[1]); if (j && !j.done) { try { j.abort.abort(); } catch {} }
          this.jobs.delete(jm[1]);
          this.sql.exec("DELETE FROM job_events WHERE id = ?", jm[1]); this.sql.exec("DELETE FROM jobs WHERE id = ?", jm[1]);
          return json({ ok: true });
        }
      }
      return err(404, "Unbekannte Anfrage.");
    } catch (e) {
      return err(500, "Serverfehler: " + (e && e.message || e));
    }
  }

  upstream(provId, rest, method, headersIn, body, signal) {
    const p = this.provider(provId);
    if (!p) throw Object.assign(new Error("Diesen Anbieter gibt es auf dem Server nicht."), { status: 404 });
    if (!p.apiKey && p.preset !== "custom") throw Object.assign(new Error(`Für ${p.name} ist auf dem Server kein Schlüssel hinterlegt.`), { status: 401 });
    const base = String(p.baseUrl || "").replace(/\/+$/, "");
    const h = new Headers();
    for (const k of ["content-type", "accept", "anthropic-version", "anthropic-beta"]) { const v = headersIn.get ? headersIn.get(k) : headersIn[k]; if (v) h.set(k, v); }
    if (p.type === "anthropic") { h.set("x-api-key", p.apiKey); if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01"); if (p.workspace) h.set("anthropic-workspace-id", p.workspace); }
    else if (p.apiKey) h.set("authorization", "Bearer " + p.apiKey);
    if (p.preset === "openrouter") { h.set("http-referer", "https://stube.app"); h.set("x-title", "Stube"); }
    return fetch(base + rest, { method, headers: h, body: method === "GET" || method === "HEAD" ? undefined : body, signal });
  }

  async forward(provId, rest, req) {
    let res;
    try { res = await this.upstream(provId, rest, req.method, req.headers, req.body); }
    catch (e) { return err(e.status || 502, e.message || "Anbieter nicht erreichbar."); }
    const h = new Headers(CORS);
    for (const k of ["content-type", "content-disposition", "cache-control"]) { const v = res.headers.get(k); if (v) h.set(k, v); }
    return new Response(res.body, { status: res.status, headers: h });
  }

  /* ---------- Aufträge: Antwort läuft hier weiter, auch ohne verbundenes Handy ---------- */
  async startJob(b) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec("DELETE FROM job_events WHERE id IN (SELECT id FROM jobs WHERE created < ?)", now - JOB_KEEP_MS);
    this.sql.exec("DELETE FROM jobs WHERE created < ?", now - JOB_KEEP_MS);
    this.sql.exec("INSERT INTO jobs (id, pid, chat, created, status, done, meta) VALUES (?, ?, ?, ?, 0, 0, ?)", id, b.pid || "", b.chat || "", now, JSON.stringify(b.meta || {}));
    const job = { id, events: [], persisted: 0, status: 0, done: false, error: null, waiters: new Set(), abort: new AbortController() };
    this.jobs.set(id, job);
    const wake = () => { for (const w of job.waiters) w(); job.waiters.clear(); };
    const persist = () => {
      for (; job.persisted < job.events.length; job.persisted++) this.sql.exec("INSERT OR REPLACE INTO job_events (id, seq, data) VALUES (?, ?, ?)", id, job.persisted, job.events[job.persisted]);
      this.sql.exec("UPDATE jobs SET status = ?, done = ?, error = ? WHERE id = ?", job.status, job.done ? 1 : 0, job.error, id);
    };
    // Bewusst nicht abgewartet: Die ausgehende Anfrage hält das Durable Object am Leben.
    (async () => {
      try {
        const res = await this.upstream(b.provider, b.path, "POST", b.headers || {}, typeof b.body === "string" ? b.body : JSON.stringify(b.body), job.abort.signal);
        job.status = res.status;
        if (!res.ok || !res.body) { job.error = await res.text(); job.done = true; persist(); wake(); return; }
        if (!/event-stream/i.test(res.headers.get("content-type") || "")) {
          // normale JSON-Antwort (z. B. Office-Dokumente): komplett als ein Eintrag speichern
          job.raw = true; job.events.push(await res.text()); job.done = true;
          this.sql.exec("UPDATE jobs SET meta = json_set(COALESCE(meta, '{}'), '$.raw', 1) WHERE id = ?", id);
          persist(); wake(); return;
        }
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let last = Date.now();
        const flush = chunk => {
          const data = chunk.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
          if (data && data !== "[DONE]") job.events.push(data);
        };
        wake();
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r/g, "");
          let i; while ((i = buf.indexOf("\n\n")) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
          if (Date.now() - last > 400) { persist(); last = Date.now(); }
          wake();
        }
        if (buf.trim()) flush(buf);
      } catch (e) {
        job.error = job.error || JSON.stringify({ error: { message: e && e.status ? e.message : "Die Verbindung zum Anbieter ist abgebrochen: " + (e && e.message || e), stube: true } });
        if (!job.status) job.status = e && e.status || 502;
      }
      job.done = true; persist(); wake();
      setTimeout(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); }, 120000);
    })();
    return id;
  }

  async pollJob(id, from) {
    let job = this.jobs.get(id);
    if (!job) {
      const r = this.sql.exec("SELECT * FROM jobs WHERE id = ?", id).toArray()[0];
      if (!r) return err(404, "Auftrag nicht gefunden.");
      const ev = this.sql.exec("SELECT data FROM job_events WHERE id = ? AND seq >= ? ORDER BY seq", id, from).toArray().map(x => x.data);
      // Ohne laufenden Auftrag im Speicher ist er entweder fertig oder durch einen Neustart verloren
      let raw = false; try { raw = !!JSON.parse(r.meta || "{}").raw; } catch {}
      return json({ status: r.status || 502, raw, events: ev, next: from + ev.length, done: true, error: r.done ? r.error : (r.error || JSON.stringify({ error: { message: "Der Auftrag wurde auf dem Server unterbrochen (z. B. durch ein Update). Bitte noch einmal senden.", stube: true } })) });
    }
    if (from >= job.events.length && !job.done && (job.status === 0 || job.status === 200)) {
      await new Promise(r => { const t = setTimeout(r, 20000); job.waiters.add(() => { clearTimeout(t); r(); }); });
    }
    const ev = job.events.slice(from);
    return json({ status: job.status, raw: !!job.raw, events: ev, next: from + ev.length, done: job.done && from + ev.length >= job.events.length, error: job.done ? job.error : null });
  }
}
