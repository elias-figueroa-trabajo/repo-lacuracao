// Lotes grandes por GitHub Actions: rutas /lote/*.
//
// Por qué existe: generar el lote en el navegador de la oficina se come 1 h 45 min con el catálogo
// de La Curacao, y casi todo ese tiempo es red. Medido el 2026-09-22 desde Lima: lacuracao entrega
// 5 fotos/s dando igual si se piden de 1 en 1 o de 30 en 30 (habla HTTP/2, así que no es un límite
// de conexiones), y un CDN neutral (Cloudflare) da 0,3-1,6 Mbps en esta misma máquina. O sea: el
// techo es la tubería de acá, no la tienda ni el navegador ni el canvas. En un runner de Actions esa
// tubería no existe, así que lo mismo baja en minutos.
//
// El pedido se guarda en auto/pedidos/<id>.json, viaja al repo público con ARMAR-REPO.bat (igual que
// las recetas de los feeds) y el workflow «Lote grande» lo reparte en varias partes. Cada parte sube
// sus piezas como artefacto de Actions; GitHub las entrega ya comprimidas, así que acá no hay código
// de ZIP ni FTP ni secretos nuevos.
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PEDIDOS = path.join(RAIZ, 'auto', 'pedidos');
const TRABAJO = path.join(RAIZ, 'publicado', '_lotes');
const CAMP = /^C\d{2}(0[1-9]|1[0-2])_[A-Z0-9]+(_[A-Z0-9]+)?$/; // igual que CAMPAIGN_RE de config.js
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const FORMATO = /^[a-z0-9]{2,6}$/;
const PIEZA = /^[a-z0-9]{2,6}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.(jpg|png)$/;
const PARTES_MAX = 20; // tope de jobs en paralelo de un plan gratuito de Actions
const TOPE_IMG = 12e6;

const leerJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const archivoPedido = id => path.join(PEDIDOS, id + '.json');
const dirParte = (id, parte) => path.join(TRABAJO, id, 'parte' + parte);

function listarPedidos() {
  if (!fs.existsSync(PEDIDOS)) return [];
  return fs.readdirSync(PEDIDOS).filter(f => f.endsWith('.json') && ID.test(f.slice(0, -5)))
    .map(f => leerJson(path.join(PEDIDOS, f), null)).filter(Boolean)
    .map(p => ({ id: p.id, campaign_id: p.campaign_id, formatos: p.formatos, partes: p.partes, productos: p.productos || 0, piezas: p.piezas || 0, creado: p.creado }))
    .sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
}

// ---------- rutas ----------
// ctx: { out, cuerpo(max) → Promise<Buffer>, permitido(url) }
async function lote(req, u, ctx) {
  const { out } = ctx, accion = u.pathname.slice('/lote/'.length);
  const id = u.searchParams.get('id') || '';

  if (req.method === 'GET' && accion === 'lista') return out(200, { pedidos: listarPedidos() });

  if (req.method === 'GET' && accion === 'pedido') {
    if (!ID.test(id)) return out(400, { error: 'id no válido' });
    const p = leerJson(archivoPedido(id), null);
    if (!p) return out(404, { error: 'No hay pedido ' + id });
    return out(200, { pedido: p });
  }

  if (req.method === 'POST' && accion === 'pedido') { // lo guarda la Fábrica
    const r = JSON.parse((await ctx.cuerpo(20e6)).toString('utf8'));
    if (!ID.test(r.id || '')) return out(400, { error: 'id no válido (letras, números, - y _)' });
    if (!CAMP.test(r.campaign_id || '')) return out(400, { error: 'campaign_id no válido' });
    if (!ctx.permitido(r.feed_url || '')) return out(400, { error: 'El lote automático necesita la URL de un feed permitido (no sirve un archivo subido a mano)' });
    const formatos = Array.isArray(r.formatos) ? r.formatos.filter(f => FORMATO.test(f)) : [];
    if (!formatos.length) return out(400, { error: 'Elige al menos un formato' });
    const pl = r.plantilla;
    if (!pl || typeof pl !== 'object' || !pl.capas || !Array.isArray(pl.orden) || !pl.pos) return out(400, { error: 'Plantilla no válida' });
    for (const f of formatos) if (!pl.pos[f]) return out(400, { error: 'La plantilla no tiene posiciones para el formato ' + f });
    const partes = Math.min(PARTES_MAX, Math.max(1, Math.round(Number(r.partes) || 1)));
    const skus = Array.isArray(r.skus) ? r.skus.map(s => String(s).slice(0, 120)).slice(0, 100000) : [];
    const pedido = { version: 1, id: r.id, campaign_id: r.campaign_id, feed_url: r.feed_url, formatos, partes,
      tipo: r.tipo === 'image/png' ? 'image/png' : 'image/jpeg', skus,
      productos: Number(r.productos) || skus.length, piezas: Number(r.piezas) || 0,
      plantilla: pl, creado: new Date().toISOString() };
    fs.mkdirSync(PEDIDOS, { recursive: true });
    fs.writeFileSync(archivoPedido(pedido.id), JSON.stringify(pedido, null, 1));
    return out(200, { ok: true, id: pedido.id, partes });
  }

  if (req.method === 'POST' && accion === 'borrar') {
    if (!ID.test(id) || !fs.existsSync(archivoPedido(id))) return out(404, { error: 'No hay pedido ' + id });
    fs.rmSync(archivoPedido(id), { force: true });
    return out(200, { ok: true });
  }

  // --- lo que usa la página sin pantalla (js/lote-auto.js) ---
  const parte = u.searchParams.get('parte') || '';
  if (!/^\d{1,2}$/.test(parte)) return out(400, { error: 'parte no válida' });
  if (!ID.test(id)) return out(400, { error: 'id no válido' });
  const d = dirParte(id, parte);

  if (req.method === 'POST' && accion === 'progreso') {
    console.log(`[${id} p${parte}] ${(await ctx.cuerpo(2000)).toString('utf8').slice(0, 300)}`);
    return out(200, { ok: true });
  }

  if (req.method === 'POST' && accion === 'img') {
    const archivo = u.searchParams.get('archivo') || '';
    if (!PIEZA.test(archivo) || archivo.includes('..')) return out(400, { error: 'Nombre de pieza no válido' });
    const buf = await ctx.cuerpo(TOPE_IMG);
    const jpg = buf[0] === 0xff && buf[1] === 0xd8;
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!jpg && !png) return out(400, { error: 'No es un JPG ni un PNG' });
    const destino = path.join(d, archivo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, buf);
    return out(200, { ok: true });
  }

  if (req.method === 'POST' && accion === 'fin') {
    const b = JSON.parse((await ctx.cuerpo(200e6)).toString('utf8') || '{}');
    fs.mkdirSync(d, { recursive: true });
    if (b.error) {
      fs.writeFileSync(path.join(d, 'fin.json'), JSON.stringify({ ok: false, error: String(b.error).slice(0, 500), cuando: new Date().toISOString() }));
      return out(200, { ok: true });
    }
    const cab = ['campaign_id', 'sku', 'formato', 'archivo', 'titulo', 'precio', 'precio_antes', 'link', 'sin_foto'];
    // Un texto que empieza con = + - @ se abre como fórmula en Excel: se antepone un apóstrofo.
    const seguro = v => { const s = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
    const esc = v => { const s = seguro(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const filas = Array.isArray(b.filas) ? b.filas : [];
    const csv = '﻿' + [cab.join(','), ...filas.map(f => cab.map(c => esc(f[c])).join(','))].join('\r\n') + '\r\n';
    fs.writeFileSync(path.join(d, `manifiesto_parte${parte}.csv`), csv);
    const res = { ok: true, parte: Number(parte), piezas: filas.length, productos: Number(b.productos) || 0,
      sinFoto: Number(b.sinFoto) || 0, pendientes: Number(b.pendientes) || 0, cuando: new Date().toISOString() };
    fs.writeFileSync(path.join(d, 'fin.json'), JSON.stringify(res));
    return out(200, res);
  }

  out(404, { error: 'Acción desconocida' });
}

module.exports = { lote, listarPedidos, archivoPedido, dirParte, PEDIDOS, TRABAJO, ID };
