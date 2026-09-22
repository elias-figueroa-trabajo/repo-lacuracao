// Servidor local. Tres trabajos:
// 1. Sirve app/.
// 2. Proxy para feeds e imágenes: los sitios del grupo no mandan CORS, así que el navegador
//    no puede leer el feed ni exportar un canvas con sus fotos sin pasar por aquí.
// 3. /api/<tabla>: guarda los datos en datos/<tabla>.csv. Las tablas y columnas son las
//    mismas que tendrá Supabase: migrar = importar estos CSV y cambiar app/js/db.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { publicar, servirPub } = require('./publicar.js');
const { magento } = require('./magento.js');
const { lote } = require('./lotes.js');

const PORT = Number(process.env.PORT) || 5180;
const ROOT = __dirname;
const DATOS = path.join(__dirname, '..', 'datos');
// Juntoz guarda feed e imágenes en su almacenamiento de Azure: se permite ese host exacto, no todo blob.core.windows.net.
const PERMITIDOS = ['lacuracao.pe', 'efe.com.pe', 'tiendasefe.com.pe', 'juntoz.com', 'motocorp.com.pe', 'efectiva.com.pe', 'juntozstgsrvproduction.blob.core.windows.net'];
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// Esquema: la primera columna es la llave. Espejo de supabase/esquema.sql.
const TABLAS = {
  campanas: ['campaign_id', 'nombre', 'marca', 'anunciante', 'inicio', 'fin', 'estado', 'dueno', 'canales', 'objetivo', 'notas', 'aprobado_por', 'aprobado_en', 'creado', 'actualizado'],
  feeds: ['id', 'url', 'nombre', 'productos', 'leido', 'bajado', 'error'], // bajado y error los escribe solo el servidor
  plantillas: ['id', 'nombre', 'datos', 'actualizado'],
  lotes: ['id', 'campaign_id', 'plantilla_id', 'formatos', 'skus', 'piezas', 'creado'],
  pedidos: ['id', 'campaign_id', 'tipo', 'titulo', 'detalle', 'marca', 'solicitante', 'responsable', 'prioridad', 'estado', 'vence', 'version', 'enlace', 'creado', 'actualizado', 'respondido', 'cerrado'],
  pedidos_historial: ['id', 'pedido_id', 'cuando', 'quien', 'accion', 'texto', 'version', 'enlace'],
  links: ['id', 'campaign_id', 'canal', 'destino', 'source', 'medium', 'content', 'url', 'marca', 'quien', 'creado'],
  // EFE Ads
  espacios: ['space_id', 'sitio', 'pagina', 'posicion', 'modo', 'medidas', 'selector', 'precio_semana', 'imp_semana', 'estado', 'notas'],
  reservas: ['id', 'space_id', 'campaign_id', 'anunciante', 'inicio', 'fin', 'estado', 'precio', 'pieza_url', 'destino', 'quien', 'creado'],
  resultados: ['id', 'reserva_id', 'semana', 'impresiones', 'clics', 'unidades', 'venta', 'fuente'],
  reportes: ['id', 'campaign_id', 'anunciante', 'recomendacion', 'quien', 'actualizado'],
  // MartechHub
  tiendas: ['store_id', 'nombre', 'marca', 'zona', 'ciudad', 'responsable', 'estado'],
  tareas_tienda: ['id', 'campaign_id', 'store_id', 'titulo', 'guia', 'vence', 'estado', 'evidencia', 'nota', 'quien', 'actualizado'],
  // Feed saliente de la Fábrica (lo escribe publicar.js, no se hace POST directo)
  publicaciones: ['id', 'campaign_id', 'formato', 'productos', 'url_feed', 'destino', 'creado'],
};

fs.mkdirSync(path.join(DATOS, 'feeds'), { recursive: true });
// Copia local de un feed (misma regla de nombre de siempre: las copias viejas siguen sirviendo).
const copiaDe = url => path.join(DATOS, 'feeds', url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_'));

// ---------- CSV ----------
const esc = v => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function leerCsv(t) {
  const f = path.join(DATOS, t + '.csv');
  if (!fs.existsSync(f)) return [];
  const txt = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
  const filas = []; let fila = [], campo = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && txt[i + 1] === '\n') i++; fila.push(campo); campo = ''; if (fila.some(x => x !== '')) filas.push(fila); fila = []; }
    else campo += ch;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const cab = filas.shift() || [];
  return filas.map(c => Object.fromEntries(cab.map((h, i) => [h, c[i] ?? ''])));
}
function escribirCsv(t, filas) {
  const cols = TABLAS[t], f = path.join(DATOS, t + '.csv');
  const txt = '﻿' + [cols.join(','), ...filas.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(f + '.tmp', txt); fs.renameSync(f + '.tmp', f); // escritura atómica
}

const SIN_BORRAR = ['campanas', 'pedidos', 'pedidos_historial'];

// Campaña fija para jugar con las herramientas sin ensuciar las reales. Nace sola si falta.
const PRUEBA = 'C9901_PRUEBA';
(function sembrarPrueba() {
  const cs = leerCsv('campanas');
  if (cs.some(c => c.campaign_id === PRUEBA)) return;
  const ahora = new Date().toISOString();
  cs.push({ campaign_id: PRUEBA, nombre: 'PRUEBA · para jugar', marca: '', estado: 'borrador', notas: 'Campaña fija para probar las herramientas. No es real: no se reporta.', creado: ahora, actualizado: ahora });
  escribirCsv('campanas', cs);
})();

// ---------- Mesa de pedidos: una operación = pedido + su movimiento ----------
// En Supabase esto pasa a ser una función RPC (una transacción). Aquí: valida contra lo guardado,
// rechaza con 409 si otra persona lo cambió antes (`_base` = `actualizado` que vio el cliente)
// y escribe el pedido y su movimiento en la misma petición.
const PED = { estados: ['nuevo', 'en_curso', 'entregado', 'cerrado', 'rechazado'], tipos: ['pedido', 'cambio'], prios: ['normal', 'urgente'] };
// accion: [estados previos permitidos, estados resultantes permitidos] (null = el mismo)
const MOV = {
  creado: [[], ['nuevo']], editado: [['nuevo', 'en_curso'], null], tomado: [['nuevo'], ['en_curso']],
  entrega: [['nuevo', 'en_curso', 'entregado'], ['entregado']], cambio: [['entregado'], ['en_curso']],
  nota: [['nuevo', 'en_curso', 'entregado'], null], cerrado: [['entregado'], ['cerrado']],
  rechazado: [['nuevo', 'en_curso'], ['rechazado']], reabierto: [['cerrado', 'rechazado'], ['nuevo', 'en_curso']],
};
const esFecha = s => !s || (/^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(new Date(s)));
function opPedido(fila, out) {
  const m = fila._mov || {}, mov = MOV[m.accion];
  if (!mov) return out(400, { error: 'Acción desconocida' });
  if (!String(m.quien || '').trim()) return out(400, { error: 'Falta quién lo hace' });
  const filas = leerCsv('pedidos'), i = filas.findIndex(r => r.id === String(fila.id)), prev = i >= 0 ? filas[i] : null;
  if (!prev && m.accion !== 'creado') return out(404, { error: 'Ese pedido no existe' });
  if (prev && m.accion === 'creado') return out(409, { error: 'Ese pedido ya existe' });
  if (prev && String(fila._base || '') !== prev.actualizado) return out(409, { error: 'Otra persona cambió este pedido. Se cargó lo último: vuelve a hacer tu cambio.' });
  const p = Object.fromEntries(TABLAS.pedidos.map(c => [c, String(fila[c] ?? (prev ? prev[c] : '')).trim()]));
  if (prev && !mov[0].includes(prev.estado)) return out(409, { error: `No se puede «${m.accion}» un pedido ${prev.estado}` });
  if (!(mov[1] || [prev.estado]).includes(p.estado)) return out(400, { error: 'Estado no válido para esa acción' });
  if (!PED.tipos.includes(p.tipo) || !PED.prios.includes(p.prioridad)) return out(400, { error: 'Tipo o prioridad no válidos' });
  if (!p.titulo || !p.solicitante) return out(400, { error: 'Falta título o solicitante' });
  if (![p.vence, p.creado, p.respondido, p.cerrado].every(esFecha)) return out(400, { error: 'Fecha no válida' });
  const ver = Number(p.version), verPrev = Number(prev?.version || 0);
  if (!Number.isInteger(ver) || ver < 0) return out(400, { error: 'Versión no válida' });
  if (m.accion === 'entrega' ? ver !== verPrev + 1 : ver !== verPrev) return out(409, { error: 'La versión no cuadra con la última entrega' });
  if (['entregado', 'cerrado'].includes(p.estado) && (!ver || !/^https?:\/\/\S+$/i.test(p.enlace))) return out(400, { error: 'Una entrega necesita versión y enlace' });
  // La campaña manda: tiene que existir, no estar cancelada al crear o moverla, y pone la marca.
  const camp = leerCsv('campanas').find(c => c.campaign_id === p.campaign_id);
  if (!camp) return out(400, { error: 'Esa campaña no existe' });
  if (camp.estado === 'cancelada' && (!prev || prev.campaign_id !== p.campaign_id)) return out(400, { error: 'Esa campaña está cancelada' });
  if (camp.marca) p.marca = camp.marca;
  if (!p.marca) return out(400, { error: 'Falta la marca' });
  const ahora = new Date().toISOString();
  p.actualizado = ahora;
  if (!prev) p.creado = ahora;
  const h = { id: 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), pedido_id: p.id, cuando: ahora,
    quien: String(m.quien).trim(), accion: m.accion, texto: String(m.texto || '').trim(),
    version: m.accion === 'entrega' ? ver : '', enlace: m.accion === 'entrega' ? p.enlace : '' };
  if (prev) filas[i] = p; else filas.push(p);
  const hs = leerCsv('pedidos_historial'); hs.push(h);
  escribirCsv('pedidos', filas); escribirCsv('pedidos_historial', hs);
  out(200, { ...p, _mov: h });
}

// ---------- Links UTM: la campaña manda y la URL final es única ----------
// Solo se crean o se borran (no se editan). Si la URL ya existe se devuelve la registrada,
// así dos pestañas que generan el mismo link no lo duplican.
const LINK_MAX = 2000;
const urlLimpia = s => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) && !u.username && !u.password && s.length <= LINK_MAX; } catch { return false; } };
const CLAVE = /^[a-z0-9][a-z0-9_.-]{0,59}$/; // canal, source, medium y content: nada que Excel lea como fórmula
function opLink(fila, out) {
  const l = Object.fromEntries(TABLAS.links.map(c => [c, String(fila[c] ?? '').trim()]));
  const camp = leerCsv('campanas').find(c => c.campaign_id === l.campaign_id);
  if (!camp) return out(400, { error: 'Esa campaña no existe' });
  if (camp.estado === 'cancelada') return out(400, { error: 'Esa campaña está cancelada' });
  if (!urlLimpia(l.destino) || !urlLimpia(l.url)) return out(400, { error: 'El destino y el link deben ser http(s), sin usuario ni clave y de hasta 2000 caracteres' });
  if (![l.canal, l.source, l.medium].every(x => CLAVE.test(x)) || (l.content && !CLAVE.test(l.content))) return out(400, { error: 'Canal, source, medium o contenido no válidos' });
  if (!l.quien || l.quien.length > 80 || /^[=+\-@\t\r]/.test(l.quien)) return out(400, { error: 'Nombre no válido' });
  const q = new URL(l.url).searchParams;
  if (q.get('utm_campaign') !== l.campaign_id || q.get('utm_id') !== l.campaign_id || q.get('utm_source') !== l.source ||
    q.get('utm_medium') !== l.medium || (q.get('utm_content') || '') !== l.content) return out(400, { error: 'El link no cuadra con su campaña, canal o contenido' });
  const filas = leerCsv('links'), ya = filas.find(r => r.url === l.url);
  if (ya) return out(200, ya);
  if (filas.some(r => r.id === l.id)) return out(409, { error: 'Ese id ya existe' });
  l.marca = camp.marca || '';
  l.creado = new Date().toISOString();
  filas.push(l); escribirCsv('links', filas);
  out(200, l);
}

function api(req, res, t, u) {
  const out = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); };
  if (!Object.hasOwn(TABLAS, t)) return out(404, { error: 'Tabla desconocida' });
  const llave = TABLAS[t][0];
  if (req.method === 'GET') return out(200, leerCsv(t));
  // Escrituras solo desde la propia página: bloquea que otra web escriba en el servidor local.
  const origen = req.headers.origin;
  if (origen && origen !== 'http://localhost:' + PORT && origen !== 'http://127.0.0.1:' + PORT) return out(403, { error: 'Origen no permitido' });
  if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) return out(415, { error: 'Se espera JSON' });
  // Campañas, pedidos y su historial no se borran: el campaign_id y el rastro no se pierden.
  if (req.method === 'DELETE' && SIN_BORRAR.includes(t)) return out(405, { error: 'Esta tabla no se borra; usa su estado' });
  if (req.method === 'DELETE') { const id = u.searchParams.get('id'); escribirCsv(t, leerCsv(t).filter(r => r[llave] !== id)); return out(200, { ok: true }); }
  if (req.method === 'POST' && t === 'pedidos_historial') return out(405, { error: 'El historial se escribe junto con el pedido' });
  if (req.method === 'POST' && t === 'publicaciones') return out(405, { error: 'Se escribe al publicar el feed' });
  if (req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8'); // no parte una ñ entre dos trozos
    req.on('data', c => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', () => {
      try {
        const fila = JSON.parse(body);
        if (!fila || typeof fila !== 'object' || Array.isArray(fila)) return out(400, { error: 'Se espera un objeto' });
        if (!fila[llave]) return out(400, { error: 'Falta ' + llave });
        if (t === 'pedidos') return opPedido(fila, out);
        if (t === 'links') return opLink(fila, out);
        if (t === 'feeds') {
          const url = String(fila.url || '');
          if (!url.startsWith('archivo:') && !permitido(url)) return out(400, { error: 'Feed fuera de los dominios permitidos (PERMITIDOS en app/server.js)' });
          const ya = leerCsv('feeds').find(r => r.id === String(fila.id));
          fila.bajado = ya?.bajado || ''; fila.error = ya?.error || '';
        }
        // Reservas: un espacio no se confirma dos veces en las mismas fechas.
        if (t === 'reservas') {
          if (!esFecha(fila.inicio) || !esFecha(fila.fin) || !fila.inicio || fila.fin < fila.inicio) return out(400, { error: 'Fechas no válidas' });
          const choca = fila.estado === 'confirmada' && leerCsv('reservas').find(r => r.id !== String(fila.id) && r.space_id === fila.space_id &&
            r.estado === 'confirmada' && r.inicio <= fila.fin && fila.inicio <= r.fin);
          if (choca) return out(409, { error: `Ese espacio ya está confirmado para ${choca.anunciante} del ${choca.inicio} al ${choca.fin}` });
        }
        const filas = leerCsv(t), i = filas.findIndex(r => r[llave] === String(fila[llave]));
        const limpia = Object.fromEntries(TABLAS[t].map(c => [c, fila[c] ?? (i >= 0 ? filas[i][c] : '')]));
        if (i >= 0) filas[i] = limpia; else filas.push(limpia);
        escribirCsv(t, filas);
        out(200, limpia);
      } catch (e) { out(400, { error: e.message }); }
    });
    return;
  }
  out(405, { error: 'Método no permitido' });
}

// ---------- Proxy ----------
const cache = new Map(); // feeds de texto, 10 min, como mucho 20
const MAX_BYTES = 80e6;
// Cabeceras para que nada que llegue por el proxy se ejecute bajo este origen.
const SEGURO = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" };
const permitido = u => {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && PERMITIDOS.some(d => x.hostname === d || x.hostname.endsWith('.' + d)); }
  catch { return false; }
};
// Baja una URL permitida. Un minuto para que responda; después, hasta 2 min para una imagen y 10
// para un feed (el de Juntoz pesa ~48 MB y tarda ~4 min).
async function traer(destino) {
  const ctl = new AbortController();
  let reloj = setTimeout(() => ctl.abort(new Error('el sitio no respondió en 60 s')), 60000);
  try {
    // Redirecciones a mano: cada salto tiene que seguir dentro de PERMITIDOS.
    let r, url = destino;
    for (let salto = 0; ; salto++) {
      r = await fetch(url, { headers: { 'User-Agent': 'EFE-Martech-Fabrica/1.0' }, redirect: 'manual', signal: ctl.signal });
      if (r.status < 300 || r.status > 399) break;
      url = new URL(r.headers.get('location') || '', url).href;
      if (salto >= 4 || !permitido(url)) throw new Error('redirección fuera de los dominios permitidos');
    }
    const tipo = r.headers.get('content-type') || 'application/octet-stream';
    clearTimeout(reloj);
    reloj = setTimeout(() => ctl.abort(new Error('la descarga pasó el tiempo máximo')), tipo.startsWith('image/') ? 120000 : 600000);
    if (Number(r.headers.get('content-length')) > MAX_BYTES) throw new Error('archivo de más de 80 MB');
    const partes = []; let n = 0;
    for await (const p of r.body) { n += p.length; if (n > MAX_BYTES) throw new Error('archivo de más de 80 MB'); partes.push(p); }
    return { status: r.status, ok: r.ok, tipo, buf: Buffer.concat(partes) };
  } finally { clearTimeout(reloj); }
}

async function proxy(req, res, destino) {
  if (!permitido(destino)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Dominio no permitido. Agrégalo a PERMITIDOS en app/server.js'); }
  const c = cache.get(destino);
  if (c && Date.now() - c.t < 600000) { res.writeHead(200, { ...SEGURO, 'Content-Type': c.tipo, 'X-Cache': 'hit' }); return res.end(c.buf); }
  // Solo los feeds registrados dejan copia en datos/feeds (las páginas de producto no). Sin copia (GitHub Actions) no hay plan B.
  const esFeed = leerCsv('feeds').some(f => f.url === destino), copia = copiaDe(destino);
  try {
    const { status, ok, tipo, buf } = await traer(destino);
    if (ok && !tipo.startsWith('image/')) {
      cache.set(destino, { t: Date.now(), tipo, buf });
      if (cache.size > 20) cache.delete(cache.keys().next().value);
      if (esFeed) fs.writeFile(copia, buf, () => {});
    }
    res.writeHead(status, { ...SEGURO, 'Content-Type': tipo, 'Cache-Control': tipo.startsWith('image/') ? 'max-age=86400' : 'no-store' });
    res.end(buf);
  } catch (e) {
    if (esFeed && fs.existsSync(copia)) { res.writeHead(200, { ...SEGURO, 'Content-Type': 'text/plain; charset=utf-8', 'X-Cache': 'copia-local' }); return res.end(fs.readFileSync(copia)); }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No se pudo leer: ' + e.message);
  }
}

// ---------- Feeds compartidos: una bajada al día, todas las herramientas leen la copia ----------
// Al arrancar se baja todo feed cuya copia tenga más de 24 h; mientras corre, otra vez a FEEDS_HORA
// (hora local, 6 por defecto). Uno a la vez para no castigar a los sitios. FEEDS_AUTO=no lo apaga
// (el runner del feed automático levanta este servidor y no necesita bajar nada).
const FEEDS_HORA = Number(process.env.FEEDS_HORA ?? 6);
const FEEDS_AUTO = process.env.FEEDS_AUTO !== 'no' && !process.env.GITHUB_ACTIONS;
const bajando = new Map(); // id → promesa (dos pedidos del mismo feed esperan la misma bajada)
function bajarFeed(id) {
  if (bajando.has(id)) return bajando.get(id);
  const p = (async () => {
    const f = leerCsv('feeds').find(r => r.id === id);
    if (!f) throw Object.assign(new Error('Ese feed no existe'), { code: 404 });
    if (!/^https?:\/\//.test(f.url)) throw new Error('Es un archivo subido a mano: no se puede bajar');
    let error = '';
    try {
      const { status, buf, tipo } = await traer(f.url);
      if (status !== 200) throw new Error('el sitio respondió ' + status);
      if (!buf.length) throw new Error('el feed llegó vacío');
      if (/^\s*(<!doctype html|<html)/i.test(buf.subarray(0, 300).toString())) throw new Error('llegó una página web, no un feed');
      const copia = copiaDe(f.url);
      fs.writeFileSync(copia + '.tmp', buf); fs.renameSync(copia + '.tmp', copia); // una copia buena no se pisa a medias
      cache.delete(f.url);
    } catch (e) { error = e.message; }
    const filas = leerCsv('feeds'), i = filas.findIndex(r => r.id === id);
    if (i >= 0) { if (!error) filas[i].bajado = new Date().toISOString(); filas[i].error = error; escribirCsv('feeds', filas); }
    console.log(`feed ${f.nombre}: ${error ? 'error, ' + error : 'bajado'}`);
    if (error) throw new Error(error + (fs.existsSync(copiaDe(f.url)) ? ' (queda la copia anterior)' : ''));
    return i >= 0 ? filas[i] : f;
  })().finally(() => bajando.delete(id));
  bajando.set(id, p);
  return p;
}
const edadCopia = url => { try { return Date.now() - fs.statSync(copiaDe(url)).mtimeMs; } catch { return Infinity; } };
async function bajarTodos(motivo, filtro = () => true) {
  const lista = leerCsv('feeds').filter(f => /^https?:\/\//.test(f.url) && filtro(f));
  if (lista.length) console.log(`Bajando ${lista.length} feed(s): ${motivo}`);
  for (const f of lista) await bajarFeed(f.id).catch(() => {});
}
if (FEEDS_AUTO) {
  const horaHoy = () => { const d = new Date(); d.setHours(FEEDS_HORA, 0, 0, 0); return d.getTime(); };
  let ultima = Date.now() >= horaHoy() ? horaHoy() : horaHoy() - 864e5; // la de hoy ya la cubre el arranque
  setTimeout(() => bajarTodos('copia de más de 24 h', f => edadCopia(f.url) > 864e5), 3000);
  setInterval(() => { if (Date.now() >= horaHoy() && ultima < horaHoy()) { ultima = horaHoy(); bajarTodos(`bajada diaria de las ${FEEDS_HORA}:00`); } }, 5 * 60000);
}

// GET /feeds/copia?id= → la copia local (si no hay, la baja primero). POST /feeds/bajar?id= → bajar ahora.
async function rutaFeeds(req, res, u) {
  const out = (code, d) => { if (res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); };
  const id = u.searchParams.get('id') || '';
  try {
    if (u.pathname === '/feeds/bajar') {
      if (req.method !== 'POST') return out(405, { error: 'Usa POST' });
      const origen = req.headers.origin;
      if (origen && origen !== 'http://localhost:' + PORT && origen !== 'http://127.0.0.1:' + PORT) return out(403, { error: 'Origen no permitido' });
      return out(200, await bajarFeed(id));
    }
    if (u.pathname === '/feeds/copia' && req.method === 'GET') {
      let f = leerCsv('feeds').find(r => r.id === id);
      if (!f) return out(404, { error: 'Ese feed no existe' });
      if (!/^https?:\/\//.test(f.url)) return out(400, { error: 'Es un archivo subido a mano: vuelve a subirlo' });
      if (!fs.existsSync(copiaDe(f.url))) f = await bajarFeed(id);
      const st = fs.statSync(copiaDe(f.url));
      if (!f.bajado) { // copia anterior a la columna: vale la fecha del archivo
        const filas = leerCsv('feeds'), i = filas.findIndex(r => r.id === id);
        if (i >= 0) { filas[i].bajado = f.bajado = st.mtime.toISOString(); escribirCsv('feeds', filas); }
      }
      res.writeHead(200, { ...SEGURO, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Bajado': f.bajado || st.mtime.toISOString() });
      return fs.createReadStream(copiaDe(f.url)).pipe(res);
    }
    out(404, { error: 'Ruta desconocida' });
  } catch (e) { out(e.code === 404 ? 404 : 502, { error: e.message }); }
}

http.createServer((req, res) => {
  try { atender(req, res); }
  catch (e) { if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Petición inválida'); }
}).listen(PORT, '127.0.0.1', () => console.log('Fábrica en http://localhost:' + PORT)); // solo esta máquina

function atender(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/proxy') return proxy(req, res, u.searchParams.get('url') || '');
  if (u.pathname.startsWith('/api/')) return api(req, res, u.pathname.slice(5), u);
  if (u.pathname.startsWith('/feeds/')) return rutaFeeds(req, res, u);
  if (u.pathname.startsWith('/publicar/')) return rutaPublicar(req, res, u);
  if (u.pathname.startsWith('/lote/')) return rutaLote(req, res, u);
  if (u.pathname.startsWith('/pub/')) return servirPub(req, res, u);
  if (u.pathname.startsWith('/magento/')) return magento(req, res, u, { local: 'http://localhost:' + PORT });
  const f = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  const rel = path.relative(ROOT, f);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('No existe'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(d);
  });
}

// Mismas reglas que /api para todo lo que escribe en disco: solo desde la propia página.
// Devuelve null (y ya respondió) si el origen no vale.
function ctxLocal(req, res) {
  const out = (code, d) => { if (res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); };
  const origen = req.headers.origin;
  if (req.method !== 'GET' && origen !== 'http://localhost:' + PORT && origen !== 'http://127.0.0.1:' + PORT) { out(403, { error: 'Origen no permitido' }); return null; }
  const cuerpo = max => new Promise((ok, mal) => {
    const partes = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { mal(new Error('Archivo demasiado grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', mal);
  });
  return { out, cuerpo, permitido, local: 'http://localhost:' + PORT };
}

// Lotes grandes por GitHub Actions (lotes.js).
function rutaLote(req, res, u) {
  const ctx = ctxLocal(req, res);
  if (ctx) lote(req, u, ctx).catch(e => ctx.out(400, { error: e.message }));
}

// Feed saliente (publicar.js).
function rutaPublicar(req, res, u) {
  const ctx = ctxLocal(req, res);
  if (!ctx) return;
  const { out, cuerpo } = ctx;
  const guardarPublicacion = fila => {
    const filas = leerCsv('publicaciones'), i = filas.findIndex(r => r.id === fila.id);
    const limpia = Object.fromEntries(TABLAS.publicaciones.map(c => [c, fila[c] ?? '']));
    if (i >= 0) filas[i] = limpia; else filas.push(limpia);
    escribirCsv('publicaciones', filas);
  };
  publicar(req, res, u, { out, cuerpo, guardarPublicacion, permitido, local: 'http://localhost:' + PORT })
    .catch(e => out(400, { error: e.message }));
}
