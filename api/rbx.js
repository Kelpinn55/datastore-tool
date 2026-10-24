// Proxy stateless ke Roblox DataStore + Ordered DataStore (Vercel Serverless Function). Wajib: env ACCESS_PASSWORD.
const crypto = require('crypto');
const enc = encodeURIComponent;
const BASE = u => `https://apis.roblox.com/datastores/v1/universes/${u}/standard-datastores`;
const OBASE = (u, n, s) => `https://apis.roblox.com/ordered-data-stores/v1/universes/${u}/orderedDataStores/${enc(n)}/scopes/${enc(s)}/entries`;
const CAP = 3000000; // batas ukuran respons per panggilan (batas Vercel 4.5 MB)
const err = (msg, status) => Object.assign(new Error(msg), { status });
const sig = () => AbortSignal.timeout(20000);
const rb = (url, key, o = {}) => fetch(url, { ...o, headers: { 'x-api-key': key, ...(o.headers || {}) }, signal: sig() });
const ra = r => Number(r.headers.get('retry-after')) || 0;
const short = async r => { try { return (await r.text()).slice(0, 200); } catch { return ''; } };
const must = async r => { if (r.ok) return r; throw Object.assign(new Error(`HTTP ${r.status} ${await short(r)}`), { status: r.status, retryAfter: ra(r) }); };
const uid = u => { if (!/^\d+$/.test(String(u))) throw err('universeId tidak valid', 400); return u; };
const okPw = req => {
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(req.headers['x-access-password'] || ''), h(process.env.ACCESS_PASSWORD));
};
const pool = (n, fn) => Promise.all(Array.from({ length: n }, fn));

// Tes baca 1 entry dari ordered datastore (nama & scope harus diketahui, tidak ada API untuk daftar nama)
const checkOrdered = async (u, key, o) => {
  try {
    const r = await rb(`${OBASE(u, o.name, o.scope || 'global')}?max_page_size=1`, key);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${await short(r)}` };
    const d = await r.json();
    return { ok: true, empty: !(d.entries || []).length };
  } catch (e) { return { ok: false, error: e.message }; }
};

const OPS = {
  async validate({ placeId, key, ordered, tolerant }) {
    if (!/^\d+$/.test(String(placeId))) throw err('Place ID harus berupa angka', 400);
    if (!key) throw err('API key wajib diisi', 400);
    const ur = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, { signal: sig() });
    if (!ur.ok) throw err(`Place ID tidak ditemukan (${ur.status})`, 404);
    const universeId = (await ur.json()).universeId; if (!universeId) throw err('Place ID tidak punya universe', 404);
    const get = async u => { try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch { return null; } };
    const [g, e] = await Promise.all([get(`https://games.roblox.com/v1/games?universeIds=${universeId}`), get(`https://economy.roblox.com/v2/assets/${placeId}/details`)]);
    const hasOrd = !!(ordered && ordered.name);
    const stores = []; let storesError = null;
    try {
      let c = '';
      for (let i = 0; i < 100; i++) {
        const r = await rb(`${BASE(universeId)}?limit=100${c ? `&cursor=${enc(c)}` : ''}`, key);
        if (r.status === 401 || r.status === 403) throw err(`API key ditolak. Detail dari Roblox: HTTP ${r.status} ${await short(r)}`, r.status);
        await must(r); const d = await r.json();
        stores.push(...(d.datastores || []).map(s => s.name)); c = d.nextPageCursor || ''; if (!c) break;
      }
    } catch (er) {
      if (!(tolerant || hasOrd)) throw er; // key mungkin hanya punya izin ordered
      storesError = er.message;
    }
    const ord = hasOrd ? await checkOrdered(universeId, key, ordered) : null;
    return { universeId, placeName: e?.Name || null, experienceName: g?.data?.[0]?.name || null, stores, storesError, ordered: ord };
  },

  async list({ universeId, key, store, cursor }) {
    uid(universeId);
    const r = await must(await rb(`${BASE(universeId)}/datastore/entries?datastoreName=${enc(store)}&AllScopes=true&limit=100${cursor ? `&cursor=${enc(cursor)}` : ''}`, key));
    const d = await r.json();
    return { keys: (d.keys || []).map(k => ({ scope: k.scope, key: k.key })), next: d.nextPageCursor || '' };
  },

  // Ordered datastore: entry + nilai datang langsung dari list (100 per request)
  async olist({ universeId, key, name, scope, cursor }) {
    uid(universeId);
    const r = await must(await rb(`${OBASE(universeId, name, scope || 'global')}?max_page_size=100&order_by=desc${cursor ? `&page_token=${enc(cursor)}` : ''}`, key));
    const d = await r.json();
    return { entries: (d.entries || []).map(e => ({ id: e.id || String(e.path || '').split('/').pop(), value: e.value })), next: d.nextPageToken || '' };
  },

  // baca banyak entry; hasil null = belum diproses (batas ukuran), klien mengulang
  async get({ universeId, key, store, items }) {
    uid(universeId); items = (items || []).slice(0, 50);
    const results = new Array(items.length).fill(null); let bytes = 0, i = 0;
    await pool(6, async () => {
      while (i < items.length && bytes < CAP) {
        const n = i++, it = items[n];
        try {
          const r = await rb(`${BASE(universeId)}/datastore/entries/entry?datastoreName=${enc(store)}&scope=${enc(it.scope)}&entryKey=${enc(it.key)}`, key);
          if (!r.ok) { results[n] = { status: r.status, retryAfter: ra(r), error: await short(r) }; continue; }
          const text = await r.text(); bytes += text.length;
          if (text.length > CAP) { results[n] = { status: 413, error: 'entry > 3 MB tidak bisa lewat proxy' }; continue; }
          results[n] = { status: 200, text, attrs: JSON.parse(r.headers.get('roblox-entry-attributes') || '{}'), uids: JSON.parse(r.headers.get('roblox-entry-userids') || '[]') };
        } catch (e) { results[n] = { status: 599, error: e.message }; }
      }
    });
    return { results };
  },

  // tulis entry biasa dan ordered (entry dengan ordered:true)
  async set({ universeId, key, entries, overwrite }) {
    uid(universeId); entries = (entries || []).slice(0, 50);
    const results = new Array(entries.length); let i = 0;
    await pool(6, async () => {
      while (i < entries.length) {
        const n = i++, e = entries[n];
        try {
          if (e.value === undefined) { results[n] = { status: 400, error: 'value kosong' }; continue; }
          let r;
          if (e.ordered) { // Ordered DataStore: nilai harus bilangan bulat
            const v = Math.trunc(Number(e.value));
            if (!Number.isFinite(v)) { results[n] = { status: 400, error: 'nilai ordered bukan angka' }; continue; }
            const base = OBASE(universeId, e.datastore, e.scope || 'global'), h = { 'content-type': 'application/json' }, body = JSON.stringify({ value: v });
            r = overwrite
              ? await rb(`${base}/${enc(e.key)}?allow_missing=true`, key, { method: 'PATCH', headers: h, body })
              : await rb(`${base}?id=${enc(e.key)}`, key, { method: 'POST', headers: h, body });
          } else {
            const body = JSON.stringify(e.value);
            const h = { 'content-type': 'application/json', 'content-md5': crypto.createHash('md5').update(body).digest('base64') };
            if (e.attributes && Object.keys(e.attributes).length) h['roblox-entry-attributes'] = JSON.stringify(e.attributes);
            if (e.userIds && e.userIds.length) h['roblox-entry-userids'] = JSON.stringify(e.userIds);
            r = await rb(`${BASE(universeId)}/datastore/entries/entry?datastoreName=${enc(e.datastore)}&scope=${enc(e.scope || 'global')}&entryKey=${enc(e.key)}${overwrite ? '' : '&exclusiveCreate=true'}`, key, { method: 'POST', headers: h, body });
          }
          results[n] = { status: r.status, retryAfter: ra(r), error: r.ok ? '' : await short(r) };
        } catch (er) { results[n] = { status: 599, error: er.message }; }
      }
    });
    return { results };
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only', status: 405 });
  if (!process.env.ACCESS_PASSWORD) return res.status(401).json({ ok: false, error: 'ACCESS_PASSWORD belum diatur di Vercel (Settings > Environment Variables), lalu Redeploy' });
  if (!okPw(req)) return res.status(401).json({ ok: false, error: 'Password akses salah' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } b = b || {};
  const fn = OPS[b.op]; if (!fn) return res.status(400).json({ ok: false, error: 'op tidak dikenal', status: 400 });
  try { return res.status(200).json({ ok: true, ...(await fn(b)) }); }
  catch (e) { return res.status(200).json({ ok: false, error: e.message, status: e.status || 500, retryAfter: e.retryAfter }); }
};
