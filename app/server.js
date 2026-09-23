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
  lotes: ['id', 'campaign_id', 'plantilla_id', 'formatos', 'skus', 'piezas', 'creado'], // historial: el lote en ZIP se retiró el 2026-09-22; solo lo lee el calendario
  pedidos: ['id', 'campaign_id', 'tipo', 'titulo', 'detalle', 'marca', 'solicitante', 'responsable', 'prioridad', 'estado', 'vence', 'version', 'enlace', 'creado', 'actualizado', 'respondido', 'cerrado'],
  pedidos_historial: ['id', 'pedido_id', 'cuando', 'quien', 'accion', 'texto', 'version', 'enlace'],
  links: ['id', 'campaign_id', 'canal', 'destino', 'source', 'medium', 'content', 'url', 'marca', 'quien', 'creado'],
  // EFE Ads
  espacios: ['space_id', 'sitio', 'pagina', 'posicion', 'modo', 'medidas', 'selector', 'precio_semana', 'imp_semana', 'estado', 'notas'],
  reservas: ['id', 'space_id', 'campaign_id', 'anunciante', 'inicio', 'fin', 'estado', 'precio', 'pieza_url', 'destino', 'quien', 'creado'],
  resultados: ['id', 'reserva_id', 'semana', 'impresiones', 'clics', 'unidades', 'venta', 'fuente'],
  reportes: ['id', 'campaign_id', 'anunciante', 'recomendacion', 'quien', 'actualizado'],
  // Marketing Studio · control de cambios de precio (riesgo regulatorio: el rastro no se borra)
  precios: ['id', 'campaign_id', 'marca', 'sku', 'producto', 'precio_actual', 'precio_nuevo', 'desde', 'hasta', 'motivo', 'estado',
    'solicitante', 'solicitado_en', 'aprobador', 'aprobado_en', 'retirado_por', 'retirado_en', 'retiro_motivo', 'creado', 'actualizado'],
  precios_historial: ['id', 'precio_id', 'cuando', 'quien', 'accion', 'texto', 'antes', 'despues'],
  // EFE Ads · aprobación de piezas de terceros
  aprobaciones: ['id', 'campaign_id', 'marca', 'anunciante', 'space_id', 'pieza_url', 'destino', 'estado', 'checks', 'revisor', 'comentario', 'quien', 'creado', 'actualizado'],
  // MartechHub
  tiendas: ['store_id', 'nombre', 'marca', 'zona', 'ciudad', 'responsable', 'estado'],
  tareas_tienda: ['id', 'campaign_id', 'store_id', 'titulo', 'guia', 'vence', 'estado', 'evidencia', 'nota', 'quien', 'actualizado'],
  comunicados: ['id', 'titulo', 'cuerpo', 'marca', 'zonas', 'prioridad', 'estado', 'vence', 'quien', 'creado', 'actualizado'],
  comunicados_leidos: ['id', 'comunicado_id', 'store_id', 'quien', 'cuando'],
  // Estilo por marca (Biblioteca de marca): una fila por marca, la llave es el nombre de la marca.
  // El logo se guarda como data URL; lo achica el navegador antes de mandarlo (LOGO_LADO).
  marcas_estilo: ['marca', 'logo', 'fuente', 'c1', 'c2', 'acento', 'nota', 'actualizado'],
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

const SIN_BORRAR = ['campanas', 'pedidos', 'pedidos_historial', 'precios', 'precios_historial', 'comunicados_leidos'];

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

// ---------- Campañas: el campaign_id es una llave maestra, no se falsea ----------
// Todo lo demás cuelga de este id (piezas, pedidos, links, reservas, reportes), así que
// el formato y el estado se comprueban aquí y no solo en el navegador. Espejo de
// CAMPAIGN_RE en app/js/config.js: si una cambia, la otra también.
const CAMPAIGN_RE = /^C\d{2}(0[1-9]|1[0-2])_[A-Z0-9]+(_[A-Z0-9]+)?$/; // C + AAMM con mes real
const ESTADOS_CAMP = ['borrador', 'aprobada', 'cancelada'];
function opCampana(fila, out) {
  const c = Object.fromEntries(TABLAS.campanas.map(k => [k, String(fila[k] ?? '').trim()]));
  if (!CAMPAIGN_RE.test(c.campaign_id)) return out(400, { error: 'El campaign_id no tiene el formato C{AAMM}_{NOMBRE}[_{ANUNCIANTE}], con mes 01-12' });
  if (!c.nombre || c.nombre.length > 120) return out(400, { error: 'La campaña necesita un nombre de hasta 120 caracteres' });
  if (c.estado && !ESTADOS_CAMP.includes(c.estado)) return out(400, { error: 'Estado no válido: ' + ESTADOS_CAMP.join(', ') });
  if (c.marca && !MARCAS.includes(c.marca)) return out(400, { error: 'Marca no válida: ' + MARCAS.join(', ') });
  if (![c.inicio, c.fin, c.aprobado_en].every(esFecha)) return out(400, { error: 'Fecha no válida' });
  if (c.inicio && c.fin && c.fin < c.inicio) return out(400, { error: 'La fecha de fin va antes que la de inicio' });
  // Nada que Excel lea como fórmula al abrir el CSV del calendario.
  for (const k of ['nombre', 'anunciante', 'dueno', 'aprobado_por']) if (/^[=+\-@\t\r]/.test(c[k])) return out(400, { error: `El campo ${k} no puede empezar por = + - @` });
  const filas = leerCsv('campanas'), i = filas.findIndex(r => r.campaign_id === c.campaign_id);
  const ahora = new Date().toISOString();
  c.creado = i >= 0 ? (filas[i].creado || ahora) : ahora; // el id nace una sola vez
  c.actualizado = ahora;
  if (i >= 0) filas[i] = c; else filas.push(c);
  escribirCsv('campanas', filas);
  out(200, c);
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

// ---------- Control de cambios de precio ----------
// Un precio mal publicado se paga en margen o en multa (CLAUDE.md §3.3), así que aquí:
// el que pide no aprueba, una caída fuerte necesita confirmación aparte, dos vigencias
// aprobadas del mismo SKU no se cruzan, y cada movimiento queda en un historial que solo crece.
const MARCAS = ['Tiendas EFE', 'La Curacao', 'Motocorp', 'Financiera Efectiva', 'Juntoz'];
const MOV_P = {
  creado: [[], ['pendiente']], editado: [['pendiente'], ['pendiente']],
  aprobado: [['pendiente'], ['aprobado']], rechazado: [['pendiente'], ['rechazado']],
  retirado: [['aprobado'], ['retirado']], // retiro de emergencia
  nota: [['pendiente', 'aprobado', 'rechazado', 'retirado'], null],
};
const CAIDA_FUERTE = 40; // % de baja a partir del cual se pide confirmar aparte
const centimos = s => /^\d{1,7}([.,]\d{1,2})?$/.test(String(s ?? '').trim()) ? Math.round(+String(s).trim().replace(',', '.') * 100) : null;
const diaOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const nombreOk = s => !!s && s.length <= 80 && !/^[=+\-@\t\r]/.test(s);

function opPrecio(fila, out) {
  const m = fila._mov || {}, mov = MOV_P[m.accion];
  if (!mov) return out(400, { error: 'Acción desconocida' });
  if (!nombreOk(String(m.quien || '').trim())) return out(400, { error: 'Falta quién lo hace' });
  const quien = String(m.quien).trim();
  const filas = leerCsv('precios'), i = filas.findIndex(r => r.id === String(fila.id)), prev = i >= 0 ? filas[i] : null;
  if (!prev && m.accion !== 'creado') return out(404, { error: 'Ese cambio de precio no existe' });
  if (prev && m.accion === 'creado') return out(409, { error: 'Ese cambio de precio ya existe' });
  if (prev && String(fila._base || '') !== prev.actualizado) return out(409, { error: 'Otra persona cambió esta solicitud. Se cargó lo último: vuelve a hacer tu cambio.' });
  const p = Object.fromEntries(TABLAS.precios.map(c => [c, String(fila[c] ?? (prev ? prev[c] : '')).trim()]));
  if (prev && !mov[0].includes(prev.estado)) return out(409, { error: `No se puede «${m.accion}» un cambio ${prev.estado}` });
  if (!(mov[1] || [prev.estado]).includes(p.estado)) return out(400, { error: 'Estado no válido para esa acción' });

  if (!/^[A-Za-z0-9._-]{1,40}$/.test(p.sku)) return out(400, { error: 'SKU no válido' });
  if (!p.producto) return out(400, { error: 'Falta el nombre del producto' });
  if (!MARCAS.includes(p.marca)) return out(400, { error: 'Marca no válida' });
  const cA = centimos(p.precio_actual), cN = centimos(p.precio_nuevo);
  if (!cA || !cN) return out(400, { error: 'Los precios van en soles, mayores que cero (ej. 1299.90)' });
  p.precio_actual = (cA / 100).toFixed(2); p.precio_nuevo = (cN / 100).toFixed(2);
  if (!diaOk(p.desde)) return out(400, { error: 'La vigencia necesita fecha de inicio' });
  if (p.hasta && (!diaOk(p.hasta) || p.hasta < p.desde)) return out(400, { error: 'La fecha de fin no puede ser anterior al inicio' });
  if (p.motivo.trim().length < 5) return out(400, { error: 'Falta el motivo del cambio' });
  if (!nombreOk(p.solicitante)) return out(400, { error: 'Falta el solicitante' });
  // La campaña es opcional (un precio puede no venir de una campaña), pero si va, manda.
  if (p.campaign_id) {
    const camp = leerCsv('campanas').find(c => c.campaign_id === p.campaign_id);
    if (!camp) return out(400, { error: 'Esa campaña no existe' });
    if (camp.estado === 'cancelada' && (!prev || prev.campaign_id !== p.campaign_id)) return out(400, { error: 'Esa campaña está cancelada' });
    if (camp.marca) p.marca = camp.marca;
  }
  // Doble confirmación: una caída fuerte no se guarda sin marcarla a propósito.
  const baja = Math.round((cA - cN) / cA * 100);
  if (['creado', 'editado'].includes(m.accion) && baja >= CAIDA_FUERTE && fila._confirmo !== true)
    return out(409, { error: `Baja de ${baja}%: confirma que el precio nuevo es correcto antes de guardar`, confirmar: baja });
  if (m.accion === 'aprobado') {
    if (!nombreOk(p.aprobador)) return out(400, { error: 'Falta quién aprueba' });
    if (p.aprobador.toLowerCase() !== quien.toLowerCase()) return out(400, { error: 'El aprobador tiene que ser quien está aprobando' });
    if (p.aprobador.toLowerCase() === p.solicitante.toLowerCase()) return out(409, { error: 'El que pide el cambio no puede aprobarlo' });
    const fin = a => a.hasta || '9999-12-31';
    const choca = filas.find(r => r.id !== p.id && r.estado === 'aprobado' && r.sku === p.sku && r.marca === p.marca &&
      r.desde <= fin(p) && p.desde <= fin(r));
    if (choca) return out(409, { error: `Ese SKU ya tiene un precio aprobado del ${choca.desde} al ${choca.hasta || 'sin fin'}` });
  }
  if (m.accion === 'retirado' && String(m.texto || '').trim().length < 5) return out(400, { error: 'El retiro de emergencia necesita un motivo' });

  const ahora = new Date().toISOString();
  if (!prev) { p.creado = ahora; p.solicitado_en = ahora; }
  if (m.accion === 'aprobado') p.aprobado_en = ahora;
  if (m.accion === 'rechazado') { p.aprobador = quien; p.aprobado_en = ahora; }
  if (m.accion === 'retirado') { p.retirado_por = quien; p.retirado_en = ahora; p.retiro_motivo = String(m.texto).trim(); }
  p.actualizado = ahora;
  const h = { id: 'hp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), precio_id: p.id, cuando: ahora,
    quien, accion: m.accion, texto: String(m.texto || '').trim(),
    antes: prev ? `${prev.precio_actual}→${prev.precio_nuevo}` : '', despues: `${p.precio_actual}→${p.precio_nuevo}` };
  if (prev) filas[i] = p; else filas.push(p);
  const hs = leerCsv('precios_historial'); hs.push(h);
  escribirCsv('precios', filas); escribirCsv('precios_historial', hs);
  out(200, { ...p, _mov: h });
}

// ---------- Aprobación de piezas de terceros (EFE Ads) ----------
const APR = ['pendiente', 'aprobada', 'cambios', 'rechazada'];
const piezaOk = s => /^\/demo\/[a-z0-9_.-]+$/i.test(s) || urlLimpia(s);
function opAprob(fila, out) {
  const filas = leerCsv('aprobaciones'), i = filas.findIndex(r => r.id === String(fila.id)), prev = i >= 0 ? filas[i] : null;
  const a = Object.fromEntries(TABLAS.aprobaciones.map(c => [c, String(fila[c] ?? (prev ? prev[c] : '')).trim()]));
  if (prev && String(fila._base || '') !== prev.actualizado) return out(409, { error: 'Otra persona cambió esta revisión. Se cargó lo último: vuelve a hacer tu cambio.' });
  const camp = leerCsv('campanas').find(c => c.campaign_id === a.campaign_id);
  if (!camp) return out(400, { error: 'Esa campaña no existe' });
  if (camp.estado === 'cancelada' && (!prev || prev.campaign_id !== a.campaign_id)) return out(400, { error: 'Esa campaña está cancelada' });
  a.marca = camp.marca || a.marca;
  if (!a.anunciante) return out(400, { error: 'Falta el anunciante' });
  if (a.space_id && !leerCsv('espacios').some(e => e.space_id === a.space_id)) return out(400, { error: 'Ese espacio no existe' });
  if (!piezaOk(a.pieza_url)) return out(400, { error: 'La pieza tiene que ser una URL http(s) sin usuario ni clave' });
  if (a.destino && !urlLimpia(a.destino)) return out(400, { error: 'El destino tiene que ser http(s) sin usuario ni clave' });
  if (!APR.includes(a.estado)) return out(400, { error: 'Estado no válido' });
  if (a.estado !== 'pendiente' && !nombreOk(a.revisor)) return out(400, { error: 'Falta el revisor' });
  if (['rechazada', 'cambios'].includes(a.estado) && a.comentario.trim().length < 5) return out(400, { error: 'Rechazar o pedir cambios necesita un comentario' });
  if (a.estado === 'aprobada' && a.checks.split('|').filter(Boolean).length < 4) return out(409, { error: 'Marca los 4 puntos de la revisión antes de aprobar' });
  if (!nombreOk(a.quien)) return out(400, { error: 'Falta quién la subió' });
  const ahora = new Date().toISOString();
  if (!prev) a.creado = ahora;
  a.actualizado = ahora;
  if (prev) filas[i] = a; else filas.push(a);
  escribirCsv('aprobaciones', filas);
  out(200, a);
}

// ---------- Comunicados (MartechHub) ----------
function opComunicado(fila, out) {
  const filas = leerCsv('comunicados'), i = filas.findIndex(r => r.id === String(fila.id)), prev = i >= 0 ? filas[i] : null;
  const c = Object.fromEntries(TABLAS.comunicados.map(k => [k, String(fila[k] ?? (prev ? prev[k] : '')).trim()]));
  if (prev && String(fila._base || '') !== prev.actualizado) return out(409, { error: 'Otra persona cambió este comunicado. Se cargó lo último: vuelve a hacer tu cambio.' });
  if (c.titulo.length < 3 || c.titulo.length > 120) return out(400, { error: 'El título va entre 3 y 120 caracteres' });
  if (c.cuerpo.trim().length < 10) return out(400, { error: 'Falta el texto del comunicado' });
  if (c.marca && !MARCAS.includes(c.marca)) return out(400, { error: 'Marca no válida' });
  if (!['normal', 'urgente'].includes(c.prioridad)) return out(400, { error: 'Prioridad no válida' });
  if (!['publicado', 'archivado'].includes(c.estado)) return out(400, { error: 'Estado no válido' });
  if (c.vence && !diaOk(c.vence)) return out(400, { error: 'Fecha de vigencia no válida' });
  if (!nombreOk(c.quien)) return out(400, { error: 'Falta quién publica' });
  const zonas = leerCsv('tiendas').map(t => t.zona);
  const malas = c.zonas.split('|').filter(Boolean).filter(z => !zonas.includes(z));
  if (malas.length) return out(400, { error: 'Zona desconocida: ' + malas[0] });
  const ahora = new Date().toISOString();
  if (!prev) c.creado = ahora;
  c.actualizado = ahora;
  if (prev) filas[i] = c; else filas.push(c);
  escribirCsv('comunicados', filas);
  out(200, c);
}

// Confirmación de lectura: una por tienda y comunicado, y no se edita ni se borra.
function opLeido(fila, out) {
  const l = Object.fromEntries(TABLAS.comunicados_leidos.map(k => [k, String(fila[k] ?? '').trim()]));
  const com = leerCsv('comunicados').find(c => c.id === l.comunicado_id);
  if (!com) return out(400, { error: 'Ese comunicado no existe' });
  if (com.estado !== 'publicado') return out(400, { error: 'Ese comunicado ya no está publicado' });
  if (!leerCsv('tiendas').some(t => t.store_id === l.store_id)) return out(400, { error: 'Esa tienda no existe' });
  if (!nombreOk(l.quien)) return out(400, { error: 'Falta quién confirma' });
  const filas = leerCsv('comunicados_leidos');
  const ya = filas.find(r => r.comunicado_id === l.comunicado_id && r.store_id === l.store_id);
  if (ya) return out(200, ya);
  l.cuando = new Date().toISOString();
  filas.push(l); escribirCsv('comunicados_leidos', filas);
  out(200, l);
}

// Estilo de una marca: se valida porque el logo es lo único que esta app guarda como imagen
// subida por una persona. Nada de URLs externas (la pieza se dibuja sin internet en el runner) ni
// de un data URL sin tope: un logo de 5 MB dentro de la plantilla revienta el pedido de lote.
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOGO_RE = /^data:image\/(png|jpeg|webp|svg\+xml);(base64,|charset=utf-8,|,)?/;
const LOGO_MAX = 2e6;
function opEstiloMarca(e, out) {
  if (!MARCAS.includes(e.marca)) return out(400, { error: 'Marca no válida: ' + MARCAS.join(', ') });
  const logo = String(e.logo || '');
  if (logo) {
    if (!LOGO_RE.test(logo)) return out(400, { error: 'El logo tiene que ser una imagen subida (PNG, JPG, WEBP o SVG), no una URL' });
    if (logo.length > LOGO_MAX) return out(400, { error: `El logo pesa ${(logo.length / 1e6).toFixed(1)} MB; el tope es 2 MB` });
  }
  const fuente = String(e.fuente || '');
  if (fuente && (fuente.length > 80 || /[<>{};]/.test(fuente))) return out(400, { error: 'Tipografía no válida' });
  for (const k of ['c1', 'c2', 'acento']) if (e[k] && !COLOR_RE.test(String(e[k]))) return out(400, { error: 'Color no válido en ' + k });
  if (String(e.nota || '').length > 300) return out(400, { error: 'La nota no puede pasar de 300 caracteres' });
  const filas = leerCsv('marcas_estilo'), i = filas.findIndex(r => r.marca === e.marca);
  const limpia = Object.fromEntries(TABLAS.marcas_estilo.map(c => [c, e[c] ?? (i >= 0 ? filas[i][c] : '')]));
  limpia.actualizado = new Date().toISOString();
  if (i >= 0) filas[i] = limpia; else filas.push(limpia);
  escribirCsv('marcas_estilo', filas);
  out(200, limpia);
}

// ---------- EFE Ads y MartechHub: los MVP dejan de escribir por el upsert genérico (2026-09-23) ----------
// Estas cinco tablas nacieron como MVP y guardaban sin validar nada en el servidor: se podía inventar
// un space_id, cruzar dos confirmadas mandando media fila (sin `estado` el choque no se miraba),
// aprobar una tarea sin evidencia o meter en `modo` un texto que el publicador pinta dentro de un
// atributo `class`. Ahora pasan por validador propio, como pedidos, precios o aprobaciones.
const SITIOS_ADS = ['efe', 'lc', 'jz', 'mc']; // prefijo del space_id; espejo de SITIOS en js/comun.js
const MODOS = ['reemplazar', 'inyectar'];
const EST_ESP = ['activo', 'pausado'];
const EST_RES = ['tentativa', 'confirmada', 'cancelada'];
const EST_TIENDA = ['activa', 'cerrada'];
const EST_TAR = ['pendiente', 'enviada', 'aprobada', 'rechazada'];
const PARTE_ID = /^[a-z0-9]{1,20}$/;
// Número de negocio: nada de negativos, NaN, "Infinity" ni cifras absurdas que deformen el reporte.
const numOk = (v, tope) => { const n = Number(v); return v !== '' && Number.isFinite(n) && n >= 0 && n <= tope; };
// La semana de un resultado siempre es su lunes: así la misma semana no entra dos veces con otra fecha.
const lunesDe = s => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
// Fila final = lo guardado + lo que llega. Validar solo lo que llega deja pasar la actualización parcial.
const fusion = (t, fila, prev) => Object.fromEntries(TABLAS[t].map(c => [c, String(fila[c] ?? (prev ? prev[c] : '')).trim()]));

function opEspacio(fila, out) {
  const filas = leerCsv('espacios'), i = filas.findIndex(r => r.space_id === String(fila.space_id)), prev = i >= 0 ? filas[i] : null;
  const e = fusion('espacios', fila, prev);
  // Manda el id (§4: los IDs maestros no se falsean): sitio, página y posición son sus propias partes.
  const p = e.space_id.split('_');
  if (p.length !== 4 || !SITIOS_ADS.includes(p[0]) || !PARTE_ID.test(p[1]) || !PARTE_ID.test(p[2]) || !/^\d{1,2}$/.test(p[3]))
    return out(400, { error: 'space_id no válido: {sitio}_{pagina}_{posicion}_{n}, con sitio ' + SITIOS_ADS.join('/') });
  if (e.sitio !== p[0] || e.pagina !== p[1] || e.posicion !== p[2]) return out(400, { error: 'El sitio, la página y la posición tienen que coincidir con el space_id' });
  if (!MODOS.includes(e.modo)) return out(400, { error: 'Modo no válido: ' + MODOS.join(' o ') });
  if (!EST_ESP.includes(e.estado)) return out(400, { error: 'Estado no válido: ' + EST_ESP.join(' o ') });
  if (e.medidas.length > 40) return out(400, { error: 'Medidas demasiado largas' });
  // El selector viaja tal cual al JSON que lee el script del sitio: desde aquí no se cierra una etiqueta.
  if (e.selector.length > 200 || /[<>`\\]/.test(e.selector)) return out(400, { error: 'Selector no válido' });
  if (e.modo === 'reemplazar' && !e.selector) return out(400, { error: 'El modo reemplazar necesita el selector del sitio' });
  if (!numOk(e.precio_semana, 1e7)) return out(400, { error: 'Precio por semana no válido' });
  if (!numOk(e.imp_semana, 1e10)) return out(400, { error: 'Impresiones por semana no válidas' });
  if (e.notas.length > 300) return out(400, { error: 'La nota no puede pasar de 300 caracteres' });
  if (prev) filas[i] = e; else filas.push(e);
  escribirCsv('espacios', filas);
  out(200, e);
}

function opReserva(fila, out) {
  const filas = leerCsv('reservas'), i = filas.findIndex(r => r.id === String(fila.id)), prev = i >= 0 ? filas[i] : null;
  const r = fusion('reservas', fila, prev);
  if (!leerCsv('espacios').some(e => e.space_id === r.space_id)) return out(400, { error: 'Ese espacio no existe en el inventario' });
  if (!EST_RES.includes(r.estado)) return out(400, { error: 'Estado no válido: ' + EST_RES.join(', ') });
  if (!diaOk(r.inicio) || !diaOk(r.fin)) return out(400, { error: 'Fechas no válidas: van como AAAA-MM-DD y tienen que ser días reales' });
  if (r.fin < r.inicio) return out(400, { error: 'La fecha de fin va después de la de inicio' });
  if (!nombreOk(r.anunciante)) return out(400, { error: 'Falta el anunciante' });
  if (!nombreOk(r.quien)) return out(400, { error: 'Falta quién reserva' });
  if (r.campaign_id) {
    const camp = leerCsv('campanas').find(c => c.campaign_id === r.campaign_id);
    if (!camp) return out(400, { error: 'Esa campaña no existe en Brief y calendario' });
    if (camp.estado === 'cancelada' && (!prev || prev.campaign_id !== r.campaign_id)) return out(400, { error: 'Esa campaña está cancelada' });
  }
  if (!numOk(r.precio, 1e7)) return out(400, { error: 'Precio no válido' });
  if (r.pieza_url && !piezaOk(r.pieza_url)) return out(400, { error: 'La pieza tiene que ser una URL http(s) sin usuario ni clave' });
  if (r.destino && !urlLimpia(r.destino)) return out(400, { error: 'El destino tiene que ser una URL http(s) sin usuario ni clave' });
  // El choque se mira sobre la fila final, no sobre lo que mandó el cliente.
  const choca = r.estado === 'confirmada' && filas.find(x => x.id !== r.id && x.space_id === r.space_id &&
    x.estado === 'confirmada' && x.inicio <= r.fin && r.inicio <= x.fin);
  if (choca) return out(409, { error: `Ese espacio ya está confirmado para ${choca.anunciante} del ${choca.inicio} al ${choca.fin}` });
  r.creado = prev ? (prev.creado || r.creado) : new Date().toISOString();
  if (prev) filas[i] = r; else filas.push(r);
  escribirCsv('reservas', filas);
  out(200, r);
}

function opResultado(fila, out) {
  const filas = leerCsv('resultados'), i = filas.findIndex(r => r.id === String(fila.id)), prev = i >= 0 ? filas[i] : null;
  const x = fusion('resultados', fila, prev);
  if (!leerCsv('reservas').some(r => r.id === x.reserva_id)) return out(400, { error: 'Esa reserva no existe' });
  if (!diaOk(x.semana)) return out(400, { error: 'Semana no válida (AAAA-MM-DD)' });
  x.semana = lunesDe(x.semana);
  if (filas.some(r => r.id !== x.id && r.reserva_id === x.reserva_id && r.semana === x.semana))
    return out(409, { error: 'Esa semana ya está cargada para esta reserva: edita la que existe' });
  for (const k of ['impresiones', 'clics', 'unidades'])
    if (!numOk(x[k], 1e10) || !Number.isInteger(Number(x[k]))) return out(400, { error: 'Valor no válido en ' + k + ': va un número entero de 0 para arriba' });
  if (!numOk(x.venta, 1e9)) return out(400, { error: 'Venta no válida' });
  if (Number(x.clics) > Number(x.impresiones)) return out(400, { error: 'No puede haber más clics que impresiones' });
  if (x.fuente.length > 40) return out(400, { error: 'Fuente demasiado larga' });
  if (prev) filas[i] = x; else filas.push(x);
  escribirCsv('resultados', filas);
  out(200, x);
}

function opTienda(fila, out) {
  const filas = leerCsv('tiendas'), i = filas.findIndex(r => r.store_id === String(fila.store_id)), prev = i >= 0 ? filas[i] : null;
  const t = fusion('tiendas', fila, prev);
  if (!/^[a-z0-9_]{3,40}$/.test(t.store_id)) return out(400, { error: 'store_id no válido: de 3 a 40 caracteres [a-z0-9_]' });
  if (!nombreOk(t.nombre)) return out(400, { error: 'Falta el nombre de la tienda' });
  if (!MARCAS.includes(t.marca)) return out(400, { error: 'Marca no válida: ' + MARCAS.join(', ') });
  if (!nombreOk(t.zona)) return out(400, { error: 'Falta la zona' });
  if (!EST_TIENDA.includes(t.estado)) return out(400, { error: 'Estado no válido: ' + EST_TIENDA.join(' o ') });
  for (const k of ['ciudad', 'responsable']) if (t[k] && !nombreOk(t[k])) return out(400, { error: 'Valor no válido en ' + k });
  if (prev) filas[i] = t; else filas.push(t);
  escribirCsv('tiendas', filas);
  out(200, t);
}

// Tareas por tienda: estado previo → estados a los que puede pasar. Sin esto, «pendiente» saltaba
// directo a «aprobada» y el cumplimiento (el KPI del sistema) se podía inflar sin subir una foto.
const MOV_T = {
  pendiente: ['pendiente', 'enviada'], enviada: ['enviada', 'aprobada', 'rechazada'],
  rechazada: ['rechazada', 'enviada', 'pendiente'], aprobada: ['aprobada', 'pendiente', 'enviada'],
};
const EVID_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/;
// Las filas de ejemplo de `demo.js` apuntan a una pieza servida por el propio servidor; sin este
// caso, una tarea de demo no se podía ni aprobar ni volver a guardar. Solo /demo/, nada externo.
const EVID_DEMO = /^\/demo\/[a-z0-9._-]+\.(svg|png|jpe?g|webp)$/;
const evidOk = v => EVID_RE.test(v) || EVID_DEMO.test(v);
const EVID_MAX = 1.5e6; // el cliente reduce a 800 px (~60 KB); el tope es contra quien no pase por él
function opTarea(fila, out) {
  const filas = leerCsv('tareas_tienda'), i = filas.findIndex(r => r.id === String(fila.id)), prev = i >= 0 ? filas[i] : null;
  const a = fusion('tareas_tienda', fila, prev);
  if (prev && String(fila._base || '') !== prev.actualizado) return out(409, { error: 'Otra persona cambió esta tarea. Se cargó lo último: vuelve a hacer tu cambio.' });
  const camp = leerCsv('campanas').find(c => c.campaign_id === a.campaign_id);
  if (!camp) return out(400, { error: 'Esa campaña no existe' });
  if (!prev && camp.estado === 'cancelada') return out(400, { error: 'Esa campaña está cancelada' });
  if (!leerCsv('tiendas').some(s => s.store_id === a.store_id)) return out(400, { error: 'Esa tienda no existe' });
  // La tarea no cambia de dueño: mover una evidencia de tienda o de campaña es reescribir el cumplimiento.
  if (prev && (a.campaign_id !== prev.campaign_id || a.store_id !== prev.store_id)) return out(400, { error: 'La campaña y la tienda de una tarea no se cambian' });
  if (!nombreOk(a.titulo)) return out(400, { error: 'Falta el título de la tarea' });
  if (a.guia.length > 2000) return out(400, { error: 'La guía no puede pasar de 2000 caracteres' });
  if (!diaOk(a.vence)) return out(400, { error: 'Fecha de vencimiento no válida (AAAA-MM-DD)' });
  if (!EST_TAR.includes(a.estado)) return out(400, { error: 'Estado no válido: ' + EST_TAR.join(', ') });
  if (prev ? !MOV_T[prev.estado]?.includes(a.estado) : a.estado !== 'pendiente')
    return out(400, { error: prev ? `Una tarea ${prev.estado} no pasa a ${a.estado}` : 'Una tarea nace pendiente' });
  if (a.evidencia) {
    if (!evidOk(a.evidencia)) return out(400, { error: 'La evidencia tiene que ser una foto subida desde la app' });
    if (a.evidencia.length > EVID_MAX) return out(400, { error: `Esa foto pesa ${(a.evidencia.length / 1e6).toFixed(1)} MB; el tope es 1,5 MB` });
  }
  if (['enviada', 'aprobada'].includes(a.estado) && !a.evidencia) return out(400, { error: 'No se envía ni se aprueba sin la foto de la evidencia' });
  if (a.estado === 'rechazada' && a.nota.trim().length < 5) return out(400, { error: 'Devolver la tarea necesita decir qué hay que corregir' });
  if (a.nota.length > 500) return out(400, { error: 'La nota no puede pasar de 500 caracteres' });
  if (!nombreOk(a.quien)) return out(400, { error: 'Falta quién hace el cambio' });
  a.actualizado = new Date().toISOString(); // la fecha la pone el servidor, no el navegador
  if (prev) filas[i] = a; else filas.push(a);
  escribirCsv('tareas_tienda', filas);
  out(200, a);
}

// Borrar de verdad solo si nada cuelga de esa fila: el cliente ya lo avisa, el servidor lo garantiza.
function puedeBorrar(t, id) {
  if (t === 'espacios') {
    const r = leerCsv('reservas').find(x => x.space_id === id && x.estado !== 'cancelada');
    if (r) return `Ese espacio tiene una reserva ${r.estado} de ${r.anunciante}: cancélala o pausa el espacio`;
  }
  if (t === 'tiendas') {
    if (leerCsv('tareas_tienda').some(x => x.store_id === id)) return 'Esa tienda tiene tareas: ciérrala en vez de borrarla';
    if (leerCsv('comunicados_leidos').some(x => x.store_id === id)) return 'Esa tienda tiene confirmaciones de lectura: ciérrala en vez de borrarla';
  }
  if (t === 'reservas') {
    const r = leerCsv('reservas').find(x => x.id === id);
    if (r && r.estado === 'confirmada') return 'Una reserva confirmada no se borra: se cancela';
    if (leerCsv('resultados').some(x => x.reserva_id === id)) return 'Esa reserva tiene resultados cargados: cancélala en vez de borrarla';
  }
  return '';
}

function api(req, res, t, u) {
  const out = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); };
  if (!Object.hasOwn(TABLAS, t)) return out(404, { error: 'Tabla desconocida' });
  const llave = TABLAS[t][0];
  if (req.method === 'GET') return out(200, leerCsv(t));
  // Escrituras solo desde la propia página: bloquea que otra web escriba en el servidor local.
  // Se exige la cabecera, no solo que cuadre: misma regla que ctxLocal() para /publicar y /lote.
  // Quien escribe siempre es el navegador (los runners de auto.js y lote.js solo leen), así que
  // una petición sin Origin no viene de la app.
  const origen = req.headers.origin;
  if (origen !== 'http://localhost:' + PORT && origen !== 'http://127.0.0.1:' + PORT) return out(403, { error: 'Origen no permitido' });
  if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) return out(415, { error: 'Se espera JSON' });
  // Campañas, pedidos y su historial no se borran: el campaign_id y el rastro no se pierden.
  if (req.method === 'DELETE' && SIN_BORRAR.includes(t)) return out(405, { error: 'Esta tabla no se borra; usa su estado' });
  if (req.method === 'DELETE') {
    const id = u.searchParams.get('id');
    const no = puedeBorrar(t, id);
    if (no) return out(409, { error: no });
    escribirCsv(t, leerCsv(t).filter(r => r[llave] !== id));
    return out(200, { ok: true });
  }
  if (req.method === 'POST' && t === 'pedidos_historial') return out(405, { error: 'El historial se escribe junto con el pedido' });
  if (req.method === 'POST' && t === 'precios_historial') return out(405, { error: 'El historial se escribe junto con el cambio de precio' });
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
        if (t === 'campanas') return opCampana(fila, out);
        if (t === 'pedidos') return opPedido(fila, out);
        if (t === 'links') return opLink(fila, out);
        if (t === 'precios') return opPrecio(fila, out);
        if (t === 'aprobaciones') return opAprob(fila, out);
        if (t === 'comunicados') return opComunicado(fila, out);
        if (t === 'comunicados_leidos') return opLeido(fila, out);
        if (t === 'marcas_estilo') return opEstiloMarca(fila, out);
        if (t === 'espacios') return opEspacio(fila, out);
        if (t === 'reservas') return opReserva(fila, out);
        if (t === 'resultados') return opResultado(fila, out);
        if (t === 'tiendas') return opTienda(fila, out);
        if (t === 'tareas_tienda') return opTarea(fila, out);
        if (t === 'feeds') {
          const url = String(fila.url || '');
          if (!url.startsWith('archivo:') && !permitido(url)) return out(400, { error: 'Feed fuera de los dominios permitidos (PERMITIDOS en app/server.js)' });
          const ya = leerCsv('feeds').find(r => r.id === String(fila.id));
          fila.bajado = ya?.bajado || ''; fila.error = ya?.error || '';
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
// Nos presentamos como un navegador, no como un robot. No es un disfraz caprichoso: el WAF de
// lacuracao.pe corta en seco a las IP de datacenter que piden fotos con un User-Agent de programa,
// y entonces una maquina entera de Actions recibe 502 en TODAS las fotos y la parte se pierde
// (le paso a las partes 5 y 6 de la corrida 35827761529). El sistema que lleva dos meses corriendo
// usa exactamente estas tres cabeceras y baja con 48 hilos sin que lo frenen; las cabeceras
// *elaboradas* (sec-fetch-*, Referer inventado) son las que gatillan el WAF, asi que no se agregan.
const CABECERAS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
};
async function traer(destino) {
  const ctl = new AbortController();
  let reloj = setTimeout(() => ctl.abort(new Error('el sitio no respondió en 60 s')), 60000);
  try {
    // Redirecciones a mano: cada salto tiene que seguir dentro de PERMITIDOS.
    let r, url = destino;
    for (let salto = 0; ; salto++) {
      r = await fetch(url, { headers: CABECERAS, redirect: 'manual', signal: ctl.signal });
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
