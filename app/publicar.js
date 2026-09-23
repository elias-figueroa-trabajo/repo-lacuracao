// Feed saliente de la Fábrica: guarda las piezas y el CSV para Meta en <proyecto>/publicado/<slug>/
// y, si hay GitHub configurado, los sube en un solo commit por tanda para que tengan URL pública.
// La configuración vive en <proyecto>/publicar.env (fuera de app/, nunca se sirve ni se devuelve el token).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { sincronizar, estadoRepos } = require('./sincronizar');

const PUB = path.join(__dirname, '..', 'publicado');
const ENV = process.env.PUBLICAR_ENV || path.join(__dirname, '..', 'publicar.env'); // la variable solo sirve para pruebas
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const ARCHIVO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.(jpg|png)$/;
const COLS = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link',
  'additional_image_link', 'brand', 'google_product_category', 'product_type', 'custom_label_0', 'custom_label_1', 'custom_label_2',
  'custom_label_3', 'custom_label_4'];
const TANDA = 60; // archivos por commit: si GitHub corta por límite, lo ya subido queda guardado

fs.mkdirSync(PUB, { recursive: true });

function config() {
  const c = {};
  try {
    for (const l of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) c[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin archivo = solo local */ }
  const repo = /^[\w.-]+\/[\w.-]+$/.test(c.GITHUB_REPO || '') ? c.GITHUB_REPO : '';
  const rama = /^[\w./-]{1,100}$/.test(c.GITHUB_RAMA || '') ? c.GITHUB_RAMA : 'main';
  let base = (c.URL_PUBLICA || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^\s]+$/.test(base)) base = repo ? `https://raw.githubusercontent.com/${repo}/${rama}` : '';
  // FTP_URL = dirección pública de la carpeta FTP_DIR (feed automático). En GitHub Actions llega como variable.
  const ftpUrl = String(process.env.FTP_URL || c.FTP_URL || '').trim().replace(/\/+$/, '');
  // PAGES_URL = raíz pública del repo que sirve GitHub Pages. En Actions sale sola del propio repo.
  let pages = String(process.env.PAGES_URL || c.PAGES_URL || '').trim().replace(/\/+$/, '');
  if (!pages && /^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY || '')) {
    const [o, r] = process.env.GITHUB_REPOSITORY.split('/');
    pages = `https://${o.toLowerCase()}.github.io/${r}`;
  }
  // Esa raíz termina escrita en cada image_link del CSV público: no puede llevar usuario ni clave.
  const publica = v => { try { const x = new URL(v); return /^https?:$/.test(x.protocol) && !x.username && !x.password && !/[\s"<>]/.test(v); } catch { return false; } };
  if (!publica(pages)) pages = '';
  const ftp = publica(ftpUrl) ? ftpUrl : '';
  return { token: c.GITHUB_TOKEN || '', repo, rama, base, api: (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
    ftpUrl: ftp, pagesUrl: pages, raiz: pages || ftp };
}
const listo = c => !!(c.token && c.repo);

const esc = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const dir = slug => path.join(PUB, slug);
const leerJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };

// El CSV se reescribe con la base que toque: la pública si hay GitHub, la local si no.
function escribirCsv(slug, raiz) { // raiz = URL de la carpeta del feed (pública o local)
  const d = leerJson(path.join(dir(slug), 'filas.json'), null);
  if (!d) return 0;
  const lineas = [COLS.join(',')];
  for (const f of d.filas) lineas.push(COLS.map(c => esc(c === 'image_link' ? raiz + '/img/' + f._img : f[c])).join(','));
  fs.writeFileSync(path.join(dir(slug), 'feed.csv'), '﻿' + lineas.join('\n') + '\n');
  return d.filas.length;
}

function resumen(slug, c, local) {
  const d = leerJson(path.join(dir(slug), 'filas.json'), {});
  return {
    slug, campaign_id: d.campaign_id || '', formato: d.formato || '', productos: (d.filas || []).length, actualizado: d.actualizado || '',
    subido: d.subido || '', url_local: local + '/pub/' + slug + '/feed.csv',
    url_publica: c.base ? c.base + '/feeds/' + slug + '/feed.csv' : '',
  };
}

// ---------- GitHub (API de datos de git: un commit por tanda, sin clonar nada) ----------
async function gh(c, metodo, ruta, cuerpo) {
  for (let intento = 0; ; intento++) {
    const r = await fetch(c.api + '/repos/' + c.repo + ruta, {
      method: metodo, signal: AbortSignal.timeout(60000),
      headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json', 'User-Agent': 'EFE-Martech-Fabrica', 'X-GitHub-Api-Version': '2022-11-28', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (r.ok) return r.json();
    const espera = Number(r.headers.get('retry-after')) || (r.headers.get('x-ratelimit-remaining') === '0' ? 60 : 0);
    if ((r.status === 403 || r.status === 429) && espera && intento < 3) { await new Promise(ok => setTimeout(ok, Math.min(espera, 90) * 1000)); continue; }
    const txt = (await r.text()).slice(0, 300);
    const e = new Error(r.status === 401 ? 'GitHub rechazó el token (401): revísalo en publicar.env'
      : r.status === 404 ? 'GitHub no encuentra el repositorio o la rama (404): revisa GITHUB_REPO, GITHUB_RAMA y que el token tenga acceso'
      : r.status === 409 ? 'El repositorio está vacío: créalo con un README y vuelve a intentar' : `GitHub ${r.status}: ${txt}`);
    e.status = r.status; throw e;
  }
}
const shaGit = buf => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');

async function subir(slug, c) {
  const n = escribirCsv(slug, c.base + '/feeds/' + slug);
  if (!n) throw new Error('Ese feed no existe');
  const pref = 'feeds/' + slug + '/';
  const locales = [['feed.csv', path.join(dir(slug), 'feed.csv')]];
  for (const f of fs.readdirSync(path.join(dir(slug), 'img'))) if (ARCHIVO.test(f)) locales.push(['img/' + f, path.join(dir(slug), 'img', f)]);
  let ref = await gh(c, 'GET', '/git/ref/heads/' + encodeURIComponent(c.rama));
  const arbol = await gh(c, 'GET', '/git/trees/' + (await gh(c, 'GET', '/git/commits/' + ref.object.sha)).tree.sha + '?recursive=1');
  const remoto = new Map(arbol.tree.filter(e => e.type === 'blob' && e.path.startsWith(pref)).map(e => [e.path, e.sha]));
  const cambios = [];
  for (const [rel, f] of locales) { const buf = fs.readFileSync(f); if (remoto.get(pref + rel) !== shaGit(buf)) cambios.push({ path: pref + rel, f }); }
  const nombres = new Set(locales.map(([rel]) => pref + rel));
  const borrar = [...remoto.keys()].filter(p => !nombres.has(p)).map(p => ({ path: p, mode: '100644', type: 'blob', sha: null }));
  // El CSV va al final: así nunca apunta a una imagen que aún no está arriba.
  cambios.sort((a, b) => (a.path.endsWith('.csv') ? 1 : 0) - (b.path.endsWith('.csv') ? 1 : 0));
  let subidos = 0;
  for (let i = 0; i < cambios.length || (i === 0 && borrar.length); i += TANDA) {
    const tanda = cambios.slice(i, i + TANDA), entradas = [];
    for (let j = 0; j < tanda.length; j += 4) // 4 a la vez
      entradas.push(...await Promise.all(tanda.slice(j, j + 4).map(async x => {
        const b = await gh(c, 'POST', '/git/blobs', { content: fs.readFileSync(x.f).toString('base64'), encoding: 'base64' });
        return { path: x.path, mode: '100644', type: 'blob', sha: b.sha };
      })));
    const ultima = i + TANDA >= cambios.length;
    if (ultima) entradas.push(...borrar);
    const t = await gh(c, 'POST', '/git/trees', { base_tree: (await gh(c, 'GET', '/git/commits/' + ref.object.sha)).tree.sha, tree: entradas });
    const cm = await gh(c, 'POST', '/git/commits', { message: `Feed ${slug}: ${tanda.length} archivos${ultima && borrar.length ? `, ${borrar.length} quitados` : ''}`, tree: t.sha, parents: [ref.object.sha] });
    ref = await gh(c, 'PATCH', '/git/refs/heads/' + encodeURIComponent(c.rama), { sha: cm.sha });
    subidos += tanda.length;
  }
  const f = path.join(dir(slug), 'filas.json'), d = leerJson(f, {});
  d.subido = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(d));
  return { subidos, sin_cambio: locales.length - cambios.length, quitados: borrar.length };
}

// ---------- Feed automático (auto.js abre auto.html sin pantalla; ver auto/LEEME.md) ----------
// Receta = qué feed, con qué plantilla y formato: <proyecto>/auto/recetas/<slug>.json (va al repo).
// Trabajo de cada corrida: <proyecto>/publicado/_auto/<slug>/ (img/ solo con lo dibujado en esta corrida,
// estado.json = lo que hay en el hosting, estado.nuevo.json = lo que habrá al terminar de subir).
const RECETAS = path.join(__dirname, '..', 'auto', 'recetas');
// PAGES_DIR mueve el trabajo al repo que publica GitHub Pages: <PAGES_DIR>/<tienda>/<nombre>/{img,feed.csv,estado.json}.
// Así lo que dibuja el navegador cae ya en su sitio definitivo y el workflow solo tiene que hacer commit.
const AUTO = process.env.PAGES_DIR ? path.resolve(process.env.PAGES_DIR) : path.join(PUB, '_auto');
const dirAuto = slug => path.join(AUTO, slug);
// Donde vive de verdad lo publicado por Pages: dentro del repo de esa tienda, en docs/ (lo que sube el
// workflow y lo que escribe app/publica.js). Antes solo se miraba publicado/_auto/, que es del camino FTP.
const dirPages = slug => path.join(__dirname, '..', 'repo-' + slug.split('/')[0], 'docs', slug);
const CAMP = /^C\d{2}(0[1-9]|1[0-2])_[A-Z0-9]+(_[A-Z0-9]+)?$/; // igual que CAMPAIGN_RE de config.js
const FIRMA = /^[0-9a-f]{64}$/;
const CAIDA = 0.5; // si salen menos de la mitad de productos que la última vez, no se publica (feed roto)
// Cada feed automático vive en <tienda>/<nombre>: carpeta por tienda en el hosting y en auto/recetas/.
const TIENDA = /^[a-z][a-z0-9-]{1,39}$/;
const NOMBRE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,59}$/;
const RUTA = /^[a-z][a-z0-9-]{1,39}\/[A-Za-z0-9][A-Za-z0-9_-]{1,59}$/; // slug = tienda/nombre
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/; // hora de Lima
const HORAS_DEF = ['07:00', '15:00'];
const PARTES_DEF = 8; // en cuántas máquinas se reparte el dibujo si la receta no dice otra cosa
// Lista todos los slugs (tienda/nombre) recorriendo auto/recetas/<tienda>/*.json.
const recetas = () => {
  try {
    const out = [];
    for (const t of fs.readdirSync(RECETAS, { withFileTypes: true })) {
      if (!t.isDirectory() || !TIENDA.test(t.name)) continue;
      for (const f of fs.readdirSync(path.join(RECETAS, t.name))) {
        if (f.endsWith('.json') && NOMBRE.test(f.slice(0, -5))) out.push(t.name + '/' + f.slice(0, -5));
      }
    }
    return out;
  } catch { return []; }
};
const vacio = () => ({ productos: {}, retirados: {} });
const LOCK_VIEJO = 6 * 60 * 60 * 1000; // una corrida completa no pasa de ~3,5 h
// Lock con pid y hora: si el proceso ya no existe (o el archivo quedó de una corrida anterior),
// se borra solo. Si no, un servidor reiniciado a media corrida dejaba el botón bloqueado para siempre.
function generando(slug) {
  const f = path.join(dirAuto(slug), 'generando.lock');
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return false; }
  const [pid, desde] = txt.split(' ').map(Number);
  const vivo = pid > 0 && (() => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })();
  if (vivo && Date.now() - (desde || 0) < LOCK_VIEJO) return true;
  fs.rmSync(f, { force: true });
  return false;
}

// Info de una receta + su último estado, para el panel «Mis feeds».
function infoReceta(slug, c, repos) {
  const receta = leerJson(path.join(RECETAS, slug + '.json'), null);
  if (!receta) return null;
  const [tienda, nombre] = slug.split('/');
  // El estado que vale es el del repo (Pages); publicado/_auto/ queda para el camino viejo por FTP.
  const estado = leerJson(path.join(dirPages(slug), 'estado.json'), null) || leerJson(path.join(dirAuto(slug), 'estado.json'), null);
  const manual = leerJson(path.join(dirAuto(slug), 'manual.json'), null);
  // La URL pública sale del repo conectado; si no hay repo, de PAGES_URL/FTP_URL de publicar.env.
  const raiz = (repos && repos[tienda] && repos[tienda].pages_url) || c.raiz;
  return {
    slug, tienda, nombre, campaign_id: receta.campaign_id || '', formato: receta.formato || '', plantilla_nombre: receta.plantilla?.nombre || '',
    activo: receta.activo !== false, horas: Array.isArray(receta.horas) && receta.horas.length ? receta.horas : HORAS_DEF,
    guardada: receta.guardada || '', productos: estado ? Object.keys(estado.productos || {}).length : 0,
    partes: Math.min(20, Math.max(1, Number(receta.partes) || PARTES_DEF)),
    actualizado: (estado && estado.actualizado) || '', generando: generando(slug),
    ultimo_manual: manual || null, url_publica: raiz ? raiz + '/' + slug + '/feed.csv' : '',
  };
}

// «Generar en esta PC»: corre publica.js como proceso aparte (dibuja en Chrome sin pantalla y deja las
// piezas y el CSV dentro de repo-<tienda>/docs/, listos para que el mismo botón de sincronizar los suba).
// Es el camino de emergencia: lo normal es «Actualizar ahora», que lo dibuja GitHub en 10-15 min.
// Solo sirve en la máquina de Elias (necesita Chrome); en Actions no se usa.
function generarAhora(slug, pagesUrl) {
  const d = dirAuto(slug);
  fs.mkdirSync(d, { recursive: true });
  const lock = path.join(d, 'generando.lock');
  try { fs.writeFileSync(lock, '0 ' + Date.now(), { flag: 'wx' }); } catch { return false; } // ya hay otra corriendo
  const logF = fs.openSync(path.join(d, 'manual.log'), 'w');
  const puerto = 5195 + Math.floor(Math.random() * 100);
  const pages = path.join(__dirname, '..', 'repo-' + slug.split('/')[0], 'docs');
  fs.mkdirSync(pages, { recursive: true });
  const hijo = spawn(process.execPath, [path.join(__dirname, 'publica.js'), slug, '--puerto', String(puerto)],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', logF, logF], windowsHide: true, detached: true,
      env: { ...process.env, PAGES_DIR: pages, ...(pagesUrl ? { PAGES_URL: pagesUrl } : {}) } });
  fs.writeFileSync(lock, hijo.pid + ' ' + Date.now());
  hijo.unref();
  hijo.on('error', () => { fs.closeSync(logF); fs.rmSync(lock, { force: true }); });
  hijo.on('exit', code => {
    fs.closeSync(logF);
    fs.rmSync(lock, { force: true });
    let mensaje = '';
    try { const lineas = fs.readFileSync(path.join(d, 'manual.log'), 'utf8').trim().split('\n'); mensaje = lineas[lineas.length - 1].slice(0, 300); } catch { /* sin log */ }
    fs.writeFileSync(path.join(d, 'manual.json'), JSON.stringify({ ok: code === 0, mensaje, cuando: new Date().toISOString() }));
  });
  return true;
}

function csvAuto(filas, raiz) {
  const lineas = [COLS.join(',')];
  for (const f of filas) lineas.push(COLS.map(c => esc(c === 'image_link' ? raiz + '/img/' + f._img : f[c])).join(','));
  return '\uFEFF' + lineas.join('\n') + '\n';
}

async function auto(req, u, accion, slug, ctx, c) {
  const { out } = ctx, d = dirAuto(slug);
  const fin = x => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'fin.json'), JSON.stringify({ ...x, cuando: new Date().toISOString() })); };
  if (accion === 'receta') { // guardar desde la Fábrica (slug = tienda/nombre)
    const r = JSON.parse((await ctx.cuerpo(10e6)).toString('utf8'));
    if (!CAMP.test(r.campaign_id || '')) return out(400, { error: 'campaign_id no válido' });
    if (!ctx.permitido(r.feed_url || '')) return out(400, { error: 'La tienda tiene que ser la URL de un feed permitido (no un archivo subido)' });
    if (!['1x1', '4x5'].includes(r.formato)) return out(400, { error: 'Formato no válido para Meta' });
    const pl = r.plantilla;
    if (!pl || typeof pl !== 'object' || !pl.capas || !Array.isArray(pl.orden) || !pl.pos || !pl.pos[r.formato]) return out(400, { error: 'Plantilla no válida' });
    const archivoReceta = path.join(RECETAS, slug + '.json');
    // Windows no distingue mayúsculas: sin esto, guardar «aniv» pisaría la receta «Aniv».
    const choque = recetas().find(o => o !== slug && o.toLowerCase() === slug.toLowerCase());
    if (choque) return out(409, { error: 'Ya existe el feed ' + choque + ' (solo cambian mayúsculas)' });
    const previa = leerJson(archivoReceta, null);
    fs.mkdirSync(path.dirname(archivoReceta), { recursive: true });
    const receta = { slug, campaign_id: r.campaign_id, feed_url: r.feed_url, formato: r.formato, plantilla: pl,
      activo: previa ? previa.activo !== false : true, horas: previa && Array.isArray(previa.horas) && previa.horas.length ? previa.horas : HORAS_DEF,
      // En cuántas máquinas se reparte el dibujo en Actions. Más partes = más rápido, tope 20 (plan gratuito).
      partes: Math.min(20, Math.max(1, Number(r.partes) || (previa && Number(previa.partes)) || PARTES_DEF)),
      guardada: new Date().toISOString() };
    fs.writeFileSync(archivoReceta, JSON.stringify(receta, null, 1));
    return out(200, infoReceta(slug, c));
  }
  if (accion === 'activo') { // pausar/activar el horario automático, sin tocar lo ya publicado
    if (!leerJson(path.join(RECETAS, slug + '.json'), null)) return out(404, { error: 'No hay receta ' + slug });
    const r = JSON.parse((await ctx.cuerpo(2000)).toString('utf8') || '{}');
    if (typeof r.activo !== 'boolean') return out(400, { error: 'activo: true o false' });
    // Se relee después del cuerpo: si mientras tanto la borraron, no se resucita.
    const receta = leerJson(path.join(RECETAS, slug + '.json'), null);
    if (!receta) return out(404, { error: 'No hay receta ' + slug });
    receta.activo = r.activo;
    fs.writeFileSync(path.join(RECETAS, slug + '.json'), JSON.stringify(receta, null, 1));
    return out(200, infoReceta(slug, c));
  }
  if (accion === 'horas') { // horario (horas de Lima en que corre el workflow)
    if (!leerJson(path.join(RECETAS, slug + '.json'), null)) return out(404, { error: 'No hay receta ' + slug });
    const r = JSON.parse((await ctx.cuerpo(2000)).toString('utf8') || '{}');
    const horas = Array.isArray(r.horas) ? [...new Set(r.horas)] : [];
    // Solo cadenas, y solo en punto: el cron de Actions corre a las :00, una hora :30 no dispararía nunca.
    if (!horas.length || !horas.every(h => typeof h === 'string' && HORA.test(h))) return out(400, { error: 'Horario no válido (usa HH:MM, hora de Lima)' });
    if (!horas.every(h => h.endsWith(':00'))) return out(400, { error: 'El automático corre en punto: usa horas como 07:00 o 15:00' });
    const receta = leerJson(path.join(RECETAS, slug + '.json'), null);
    if (!receta) return out(404, { error: 'No hay receta ' + slug });
    receta.horas = horas.sort();
    fs.writeFileSync(path.join(RECETAS, slug + '.json'), JSON.stringify(receta, null, 1));
    return out(200, infoReceta(slug, c));
  }
  if (accion === 'partes') { // en cuántas máquinas se reparte el dibujo en Actions
    if (!leerJson(path.join(RECETAS, slug + '.json'), null)) return out(404, { error: 'No hay receta ' + slug });
    const r = JSON.parse((await ctx.cuerpo(2000)).toString('utf8') || '{}');
    const n = Number(r.partes);
    // 20 es el tope de trabajos en paralelo del plan gratuito: pedir más solo hace cola.
    if (!Number.isInteger(n) || n < 1 || n > 20) return out(400, { error: 'Partes: un número del 1 al 20' });
    const receta = leerJson(path.join(RECETAS, slug + '.json'), null);
    if (!receta) return out(404, { error: 'No hay receta ' + slug });
    receta.partes = n;
    fs.writeFileSync(path.join(RECETAS, slug + '.json'), JSON.stringify(receta, null, 1));
    return out(200, infoReceta(slug, c));
  }
  if (accion === 'borrar') { // solo quita la receta local (deja de programarse); no borra lo ya publicado en el hosting
    if (!leerJson(path.join(RECETAS, slug + '.json'), null)) return out(404, { error: 'No hay receta ' + slug });
    if (generando(slug)) return out(409, { error: 'Se está generando ahora mismo: espera a que termine' });
    fs.rmSync(path.join(RECETAS, slug + '.json'), { force: true });
    return out(200, { ok: true });
  }
  if (accion === 'generar') { // dibujar aquí mismo (necesita Chrome); deja todo en repo-<tienda>/docs/
    const receta = leerJson(path.join(RECETAS, slug + '.json'), null);
    if (!receta) return out(404, { error: 'No hay receta ' + slug });
    if (generando(slug)) return out(409, { error: 'Ya se está generando' });
    let pages = c.pagesUrl;
    try { pages = estadoRepos([slug.split('/')[0]])[slug.split('/')[0]].pages_url || pages; } catch { /* sin repo: queda PAGES_URL */ }
    if (!pages) return out(409, { error: 'No se sabe la dirección pública: conecta el repo de la tienda con SUBIR-REPO.bat (o pon PAGES_URL en publicar.env)' });
    if (!generarAhora(slug, pages)) return out(409, { error: 'Ya se está generando' });
    return out(200, { ok: true });
  }
  if (accion === 'progreso') { console.log(`[${slug}] ${(await ctx.cuerpo(2000)).toString('utf8').slice(0, 300)}`); return out(200, { ok: true }); }
  if (accion === 'auto-fin') { // la página avisa que se cortó
    const r = JSON.parse((await ctx.cuerpo(20000)).toString('utf8') || '{}');
    fin({ ok: false, error: String(r.error || 'error desconocido').slice(0, 500) });
    return out(200, { ok: true });
  }
  if (accion === 'auto-img') {
    const archivo = u.searchParams.get('archivo') || '';
    if (!ARCHIVO.test(archivo) || !archivo.endsWith('.jpg')) return out(400, { error: 'Nombre de archivo no válido' });
    const buf = await ctx.cuerpo(8e6);
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return out(400, { error: 'No es un JPG' });
    fs.mkdirSync(path.join(d, 'img'), { recursive: true });
    fs.writeFileSync(path.join(d, 'img', archivo), buf);
    return out(200, { ok: true });
  }
  if (accion === 'auto-parte') { // una parte de un lote repartido: solo deja sus filas para el paso de unir
    const parte = Number(u.searchParams.get('parte'));
    if (!Number.isInteger(parte) || parte < 0 || parte > 99) return out(400, { error: 'parte no válida' });
    const b = JSON.parse((await ctx.cuerpo(400e6)).toString('utf8'));
    if (!Array.isArray(b.filas)) return out(400, { error: 'La parte no trae filas' });
    fs.mkdirSync(path.join(d, 'partes'), { recursive: true });
    fs.writeFileSync(path.join(d, 'partes', `parte${parte}.json`), JSON.stringify(b));
    const res = { ok: true, parte, filas: b.filas.length, nuevas: Number(b.dibujadas) || 0 };
    fin(res);
    return out(200, res);
  }
  if (accion === 'auto-unir') { // junta las partes y escribe el CSV (lo corre app/publica.js, no el navegador)
    const de = Number(u.searchParams.get('de')) || 1;
    const dp = path.join(d, 'partes');
    const hay = fs.existsSync(dp) ? fs.readdirSync(dp).filter(f => /^parte\d+\.json$/.test(f)) : [];
    // Con una parte de menos el CSV saldría incompleto y Meta daría de baja esos productos:
    // antes que publicar a medias, se deja el feed anterior y falla la corrida.
    if (hay.length < de) return out(409, { error: `Faltan partes: llegaron ${hay.length} de ${de}. No se publica un CSV incompleto` });
    const b = { filas: [], leidos: 0, atrasadas: 0, dibujadas: 0, fuera: {} };
    for (const f of hay) {
      const p = leerJson(path.join(dp, f), {});
      b.filas.push(...(p.filas || []));
      b.leidos += Number(p.leidos) || 0;
      b.atrasadas += Number(p.atrasadas) || 0;
      b.dibujadas += Number(p.dibujadas) || 0;
      for (const [k, v] of Object.entries(p.fuera || {})) b.fuera[k] = (b.fuera[k] || 0) + (Number(v) || 0);
    }
    return cerrar(b);
  }
  if (accion === 'auto-feed') return cerrar(JSON.parse((await ctx.cuerpo(400e6)).toString('utf8')));

  out(404, { error: 'Acción desconocida' });

  // Escribe feed.csv y estado.nuevo.json con TODAS las filas de la corrida (enteras o ya unidas).
  // Quien sube (ftp.js) o hace commit (publica.js) se encarga después de las imágenes retiradas.
  function cerrar(b) {
    if (!c.raiz) return out(409, { error: 'Falta PAGES_URL (o FTP_URL): la dirección pública donde vive el feed' });
    if (!Array.isArray(b.filas) || !b.filas.length) return out(400, { error: 'El feed no trae filas' });
    const prev = { ...vacio(), ...leerJson(path.join(d, 'estado.json'), {}) };
    const receta = leerJson(path.join(RECETAS, slug + '.json'), {});
    const conocidos = new Set([...Object.values(prev.productos).map(x => x[1]), ...Object.keys(prev.retirados)]);
    const nPrev = Object.keys(prev.productos).length;
    if (nPrev >= 50 && b.filas.length < nPrev * CAIDA && !receta.permitir_caida) {
      const error = `Salen ${b.filas.length} productos contra ${nPrev} la última vez: no se publica (¿el feed de la tienda vino roto?). Si la baja es real, pon "permitir_caida": true en la receta una vez.`;
      fin({ ok: false, error }); return out(409, { error });
    }
    const img = path.join(d, 'img'), productos = {}, filas = [];
    let nuevas = 0, repetidos = 0;
    for (const f of b.filas) {
      if (!f || !f.id || !ARCHIVO.test(f._img || '') || !FIRMA.test(f._firma || '')) return out(400, { error: 'Fila sin id, imagen o firma: ' + String(f && f.id).slice(0, 40) });
      if (Object.hasOwn(productos, f.id)) { repetidos++; continue; } // dos partes pueden traer el mismo id: gana la primera
      const local = fs.existsSync(path.join(img, f._img));
      if (!local && !conocidos.has(f._img)) return out(400, { error: 'Falta la imagen ' + f._img });
      if (local) nuevas++;
      productos[f.id] = [f._firma, f._img, /^[0-9a-f]{16}$/.test(f._pf || '') ? f._pf : ''];
      filas.push(Object.fromEntries([...COLS.filter(k => k !== 'image_link').map(k => [k, String(f[k] ?? '').slice(0, 10000)]), ['_img', f._img]]));
    }
    // Con Pages img/ es la carpeta del repo (no se vacía cada corrida), así que «nuevas» lo dice el navegador.
    if (process.env.PAGES_DIR) nuevas = Number(b.dibujadas) || 0;
    // Lo que salió del feed no se borra enseguida: Meta pudo leer el CSV anterior y aún no bajar esa imagen.
    const usados = new Set(Object.values(productos).map(x => x[1])), ahora = new Date().toISOString(), retirados = {};
    for (const a of conocidos) if (!usados.has(a)) retirados[a] = prev.retirados[a] || ahora;
    fs.writeFileSync(path.join(d, 'feed.csv'), csvAuto(filas, c.raiz + '/' + slug));
    fs.writeFileSync(path.join(d, 'estado.nuevo.json'), JSON.stringify({ version: 1, slug, actualizado: ahora, productos, retirados }));
    const res = { productos: filas.length, nuevas, reusadas: filas.length - nuevas, retiradas: Object.keys(retirados).length,
      atrasadas: Number(b.atrasadas) || 0, leidos: Number(b.leidos) || 0,
      fuera: { ...(b.fuera || {}), repetidos: ((b.fuera || {}).repetidos || 0) + repetidos } };
    fin({ ok: true, ...res });
    return out(200, res);
  }
}

// ---------- Rutas: /publicar/* (API) y /pub/* (archivos locales) ----------
// ctx: { out, cuerpo(max) → Promise<Buffer>, local, guardarPublicacion(fila) }
async function publicar(req, res, u, ctx) {
  const { out } = ctx, c = config(), accion = u.pathname.slice('/publicar/'.length);
  if (req.method === 'GET' && accion === 'estado') {
    const feeds = fs.readdirSync(PUB).filter(s => SLUG.test(s) && fs.existsSync(path.join(dir(s), 'filas.json'))).map(s => resumen(s, c, ctx.local));
    const rs = recetas();
    // Un repo por tienda: el panel necesita saber cuáles ya están conectados para ofrecer «Actualizar ahora».
    let repos = {};
    try { repos = estadoRepos([...new Set(rs.map(s => s.split('/')[0]))]); } catch { /* sin git instalado */ }
    return out(200, { github: listo(c), repo: c.repo, rama: c.rama, base: c.base, feeds, recetas: rs.map(s => infoReceta(s, c, repos)).filter(Boolean), ftp_url: c.ftpUrl, pages_url: c.pagesUrl, repos });
  }
  if (req.method === 'GET' && accion === 'receta') {
    const slug = u.searchParams.get('slug') || '';
    const receta = RUTA.test(slug) && leerJson(path.join(RECETAS, slug + '.json'), null);
    if (!receta) return out(404, { error: 'No hay receta ' + slug });
    return out(200, { receta, estado: { ...vacio(), ...leerJson(path.join(dirAuto(slug), 'estado.json'), {}) } });
  }
  if (req.method !== 'POST') return out(405, { error: 'Método no permitido' });
  // Subir a GitHub lo que hay ahora (código + recetas) y, si se pide, disparar una corrida ya mismo.
  // Es el mismo trabajo de SUBIR-REPO.bat, hecho desde el panel «Mis feeds».
  if (accion === 'sincronizar') {
    const b = JSON.parse((await ctx.cuerpo(4000)).toString('utf8') || '{}');
    const tienda = String(b.tienda || '');
    if (!TIENDA.test(tienda)) return out(400, { error: 'Tienda no válida' });
    const pedidos = Array.isArray(b.slugs) ? b.slugs.filter(x => typeof x === 'string' && RUTA.test(x) && x.startsWith(tienda + '/')) : [];
    // Solo se pide correr lo que existe como receta: así un slug inventado no viaja al repo.
    const hay = new Set(recetas());
    if (pedidos.some(x => !hay.has(x))) return out(404, { error: 'Ese feed no existe' });
    try { return out(200, sincronizar(tienda, pedidos)); }
    catch (e) { return out(409, { error: e.message }); }
  }
  const ACCIONES_AUTO = ['receta', 'progreso', 'auto-fin', 'auto-img', 'auto-feed', 'auto-parte', 'auto-unir', 'activo', 'horas', 'partes', 'borrar', 'generar'];
  const slug = u.searchParams.get('slug') || '';
  if (ACCIONES_AUTO.includes(accion)) {
    if (!RUTA.test(slug)) return out(400, { error: 'Nombre de feed no válido (tienda/nombre)' });
    return auto(req, u, accion, slug, ctx, c);
  }
  if (!SLUG.test(slug)) return out(400, { error: 'Nombre de feed no válido (letras, números, _ y -)' });
  if (accion === 'img') {
    const archivo = u.searchParams.get('archivo') || '';
    if (!ARCHIVO.test(archivo)) return out(400, { error: 'Nombre de archivo no válido' });
    if (!/^image\/(jpeg|png)$/.test(req.headers['content-type'] || '')) return out(415, { error: 'Se espera JPG o PNG' });
    const buf = await ctx.cuerpo(8e6);
    const jpg = buf[0] === 0xff && buf[1] === 0xd8, png = buf[0] === 0x89 && buf[1] === 0x50;
    if (!(archivo.endsWith('.jpg') ? jpg : png)) return out(400, { error: 'El archivo no es la imagen que dice ser' });
    fs.mkdirSync(path.join(dir(slug), 'img'), { recursive: true });
    fs.writeFileSync(path.join(dir(slug), 'img', archivo), buf);
    return out(200, { ok: true, bytes: buf.length });
  }
  if (accion === 'feed') {
    if (!String(req.headers['content-type']).startsWith('application/json')) return out(415, { error: 'Se espera JSON' });
    const d = JSON.parse((await ctx.cuerpo(60e6)).toString('utf8'));
    if (!Array.isArray(d.filas) || !d.filas.length) return out(400, { error: 'El feed no trae filas' });
    const img = path.join(dir(slug), 'img'), usadas = new Set(), filas = [];
    for (const f of d.filas) {
      if (!f || !f.id || !ARCHIVO.test(f._img || '')) return out(400, { error: 'Fila sin id o sin imagen: ' + String(f && f.id).slice(0, 40) });
      if (!fs.existsSync(path.join(img, f._img))) return out(400, { error: 'Falta la imagen ' + f._img });
      usadas.add(f._img);
      filas.push(Object.fromEntries([...COLS.filter(k => k !== 'image_link').map(k => [k, String(f[k] ?? '').slice(0, 10000)]), ['_img', f._img]]));
    }
    // Las piezas de publicaciones anteriores que ya no están en el feed se quitan (y en GitHub al subir).
    for (const f of fs.readdirSync(img)) if (!usadas.has(f)) fs.unlinkSync(path.join(img, f));
    const meta = { campaign_id: String(d.campaign_id || ''), formato: String(d.formato || ''), actualizado: new Date().toISOString(), filas };
    fs.writeFileSync(path.join(dir(slug), 'filas.json'), JSON.stringify(meta));
    escribirCsv(slug, ctx.local + '/pub/' + slug); // en local hasta que se suba
    const r = resumen(slug, c, ctx.local);
    ctx.guardarPublicacion({ id: slug, campaign_id: meta.campaign_id, formato: meta.formato, productos: filas.length,
      url_feed: r.url_local, destino: 'local', creado: meta.actualizado });
    return out(200, { ...r, github: listo(c) });
  }
  if (accion === 'subir') {
    if (!listo(c)) return out(409, { error: 'Falta configurar GitHub en publicar.env (ver publicar.env.ejemplo)' });
    try {
      const r = await subir(slug, c), s = resumen(slug, c, ctx.local);
      ctx.guardarPublicacion({ id: slug, campaign_id: s.campaign_id, formato: s.formato, productos: s.productos,
        url_feed: s.url_publica, destino: 'github:' + c.repo, creado: s.subido });
      return out(200, { ...r, ...s });
    } catch (e) { return out(502, { error: e.message }); }
  }
  out(404, { error: 'Acción desconocida' });
}

// Archivos publicados, para verlos en local antes de subir.
function servirPub(req, res, u) {
  const partes = decodeURIComponent(u.pathname).split('/').filter(Boolean).slice(1); // quita «pub»
  const ok = (partes.length === 2 && SLUG.test(partes[0]) && partes[1] === 'feed.csv') ||
    (partes.length === 3 && SLUG.test(partes[0]) && partes[1] === 'img' && ARCHIVO.test(partes[2]));
  const f = ok && path.join(PUB, ...partes);
  if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('No existe'); }
  const tipo = f.endsWith('.csv') ? 'text/csv; charset=utf-8' : f.endsWith('.png') ? 'image/png' : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(f).pipe(res);
}

module.exports = { publicar, servirPub, AUTO, RECETAS };
