// Lectura de feeds de producto: Google Merchant en TXT/TSV, CSV, XML (RSS/Atom) o JSON.
// Devuelve siempre la misma forma de producto para que el lienzo no dependa del origen.
import { proxied } from './config.js';

const ALIAS = {
  sku: ['id', 'sku', 'item_id', 'offer_id', 'codigo'],
  title: ['title', 'titulo', 'name', 'nombre'],
  price: ['price', 'precio'],
  sale_price: ['sale_price', 'precio_oferta', 'special_price'],
  image: ['image_link', 'image', 'imagen', 'image_url'],
  link: ['link', 'url'],
  brand: ['brand', 'marca'],
  category: ['product_type', 'google_product_category', 'categoria', 'category'],
  availability: ['availability', 'disponibilidad', 'stock'],
};

const norm = k => String(k || '').trim().toLowerCase().replace(/^g:/, '');

export function precio(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const cur = (s.match(/[A-Z]{3}/) || [])[0] || (s.includes('S/') ? 'PEN' : 'PEN');
  let n = s.replace(/[^\d.,-]/g, '');
  if (n.includes(',') && n.includes('.')) n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  else if (n.includes(',')) n = /,\d{2}$/.test(n) ? n.replace(',', '.') : n.replace(/,/g, '');
  const num = parseFloat(n);
  return isNaN(num) ? null : { v: num, cur };
}

export const fmtPrecio = p => !p ? '' : (p.cur === 'PEN' ? 'S/ ' : p.cur + ' ') + p.v.toLocaleString('es-PE', { minimumFractionDigits: p.v % 1 ? 2 : 0, maximumFractionDigits: 2 });

function mapear(fila) {
  const r = {};
  for (const k in fila) r[norm(k)] = fila[k];
  const get = campo => { for (const a of ALIAS[campo]) if (r[a] != null && String(r[a]).trim() !== '') return String(r[a]).trim(); return ''; };
  const p = precio(get('price')), sp = precio(get('sale_price'));
  const oferta = sp && p && sp.v < p.v;
  const cat = get('category');
  return {
    sku: get('sku'), title: textoPlano(get('title')), link: get('link'), image: get('image'), brand: get('brand'),
    category: cat.split('>').map(x => x.trim()).filter(Boolean).slice(0, 2).join(' > '),
    price: oferta ? sp : p, oldPrice: oferta ? p : null,
    stock: !/out|agotado|sin stock/i.test(get('availability')),
    raw: r,
  };
}

// CSV/TSV con comillas, sin librerías.
function delimitado(txt) {
  const primera = txt.slice(0, txt.indexOf('\n') + 1 || txt.length);
  const sep = primera.includes('\t') ? '\t' : (primera.split(';').length > primera.split(',').length ? ';' : ',');
  if (sep === '\t' && !/(^|\t)"/m.test(txt)) { // TXT de Merchant sin campos entrecomillados: camino rápido
    const lineas = txt.split(/\r?\n/).filter(l => l.trim());
    const cab = lineas.shift().split('\t');
    return lineas.map(l => { const c = l.split('\t'), o = {}; cab.forEach((h, i) => o[h] = c[i]); return o; });
  }
  const filas = []; let fila = [], campo = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += ch; continue; }
    if (ch === '"' && campo === '') q = true; // solo abre comillas al inicio del campo: «TV 55"» no rompe la fila
    else if (ch === sep) { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && txt[i + 1] === '\n') i++; fila.push(campo); campo = ''; if (fila.some(x => x !== '')) filas.push(fila); fila = []; }
    else campo += ch;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const cab = filas.shift() || [];
  return filas.map(c => { const o = {}; cab.forEach((h, i) => o[h] = c[i]); return o; });
}

function xml(txt) {
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El XML no es válido');
  // Por nombre local y cualquier namespace: <item>, <entry> y <atom:entry>.
  const nodos = [...doc.getElementsByTagNameNS('*', 'item'), ...doc.getElementsByTagNameNS('*', 'entry')];
  const GOOGLE = 'http://base.google.com/ns/1.0';
  return nodos.map(n => {
    const o = {}, deGoogle = new Set();
    for (const c of n.children) {
      const g = c.namespaceURI === GOOGLE, k = c.localName;
      // Gana el primero, salvo que llegue el de Google Merchant: <g:id> es el SKU aunque antes venga <atom:id>.
      if (k in o && (deGoogle.has(k) || !g)) continue;
      o[k] = c.getAttribute('href') || c.textContent;
      if (g) deGoogle.add(k);
    }
    return o;
  });
}

function json(txt) {
  const d = JSON.parse(txt);
  const arr = Array.isArray(d) ? d : (d.items || d.products || d.productos || d.data || []);
  if (!Array.isArray(arr)) throw new Error('No encontré una lista de productos en el JSON');
  return arr;
}

export function parsear(txt) {
  const t = txt.replace(/^\uFEFF/, '').trimStart();
  const filas = t.startsWith('<') ? xml(t) : (t.startsWith('[') || t.startsWith('{')) ? json(t) : delimitado(t);
  return filas.map(mapear).filter(p => p.sku && p.title);
}

export async function leerFeed(url) {
  const r = await fetch(proxied(url));
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || 'Error ' + r.status);
  const productos = parsear(await r.text());
  if (!productos.length) throw new Error('El feed no trae productos con id y título');
  const origen = new URL(url).hostname.replace(/^www\./, '');
  productos.forEach(p => p.feed = origen);
  return productos;
}

// ---------- Feeds compartidos ----------
// El servidor baja cada feed de la tabla `feeds` una vez al día; las herramientas leen su copia local
// (/feeds/copia) y no vuelven a descargar. «Actualizar» pide una bajada ahora (/feeds/bajar).
const jOk = async r => { const t = await r.text(); if (r.ok) return t; let m = t; try { m = JSON.parse(t).error; } catch {} throw new Error(m || 'Error ' + r.status); };
export async function leerCopia(f) {
  const r = await fetch('/feeds/copia?id=' + encodeURIComponent(f.id));
  const bajado = r.headers.get('X-Bajado') || '';
  const productos = parsear(await jOk(r));
  if (!productos.length) throw new Error('El feed no trae productos con id y título');
  return { productos, bajado };
}
export const bajarAhora = f => fetch('/feeds/bajar?id=' + encodeURIComponent(f.id), { method: 'POST' }).then(jOk).then(JSON.parse);
export const esUrlFeed = f => /^https?:\/\//.test(f?.url || '');
export const nombreFeed = url => new URL(url).hostname.replace(/^www\./, '') + ' · ' + url.split('/').pop();
// «bajado 22 sep, 07:00» / «error: …» / «sin bajar todavía»
export function textoBajada(f) {
  if (!esUrlFeed(f)) return 'archivo subido a mano';
  const d = new Date(f.bajado), cu = isNaN(d) ? '' : d.toLocaleString('es-PE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const viejo = !isNaN(d) && Date.now() - d > 30 * 3600e3;
  return (cu ? `bajado ${cu}${viejo ? ' (viejo)' : ''}` : 'sin bajar todavía') + (f.error ? ` · falló la última: ${f.error}` : '');
}

// ---------- Texto limpio y feed saliente para Meta ----------
// Juntoz manda entidades HTML sin punto y coma (&ntilde, &oacuten, &nbsp): se decodifica el nombre
// más largo que exista y se deja el resto («&oacuten» → «ón»).
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿',
  deg: '°', ordm: 'º', ordf: 'ª', reg: '®', copy: '©', trade: '™', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', bull: '•',
  middot: '·', times: '×', frac12: '½', sup2: '²', sup3: '³', micro: 'µ', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', acute: '´',
  Prime: '″', prime: '′', plusmn: '±', thinsp: ' ', beta: 'β', agrave: 'à', egrave: 'è', ograve: 'ò', auml: 'ä', ouml: 'ö',
  ccedil: 'ç', otilde: 'õ', atilde: 'ã', igrave: 'ì', oslash: 'ø', Oslash: 'Ø', Omega: 'Ω', alpha: 'α', shy: '', lrm: '' };
// Juntoz trae entidades cortadas en la fuente («&oac», «&nbs»): se completan si solo una entidad empieza así.
const PREFIJO = n => { const k = Object.keys(ENT).filter(x => x.length > n.length && x.startsWith(n)); return k.length === 1 ? ENT[k[0]] : null; };
export function textoPlano(s) {
  if (!s) return '';
  let t = String(s).replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  for (let i = 0; i < 2; i++) // dos vueltas: a veces llega «&amp;ntilde;»
    t = t.replace(/&#(\d{1,7});?|&#x([0-9a-f]{1,6});?|&([a-z][a-z0-9]{1,9})(;?)/gi, (m, d, h, n, pc) => {
      if (d || h) { const c = d ? +d : parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
      if (pc) return ENT[n] ?? PREFIJO(n) ?? m;
      for (let k = n.length; k >= 2; k--) if (ENT[n.slice(0, k)]) return ENT[n.slice(0, k)] + n.slice(k);
      return PREFIJO(n) ?? m;
    });
  return t.replace(/[ - ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Columnas del CSV para el catálogo de Meta (nombres de su plantilla). El servidor escribe el mismo orden.
export const COLS_META = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link',
  'additional_image_link', 'brand', 'google_product_category', 'product_type', 'custom_label_0', 'custom_label_1', 'custom_label_2',
  'custom_label_3', 'custom_label_4'];
const urlSegura = u => String(u || '').trim().replace(/ /g, '%20');
const precioMeta = p => p ? p.v.toFixed(2) + ' ' + p.cur : '';

// Un producto del feed entrante → una fila del feed saliente (image_link lo pone el servidor)
// y los avisos de lo que Meta rechazaría.
export function filaMeta(p) {
  const r = p.raw || {}, av = [];
  const disp = String(r.availability || '').toLowerCase().replace(/_/g, ' ').trim();
  const cond = String(r.condition || '').toLowerCase();
  const fila = {
    id: p.sku,
    title: textoPlano(p.title).slice(0, 200),
    description: textoPlano(r.description || r.descripcion || '').slice(0, 9999) || textoPlano(p.title),
    availability: /out|agotado|sin stock/.test(disp) ? 'out of stock' : /pre-?order/.test(disp) ? 'preorder' : 'in stock',
    condition: /used|usado/.test(cond) ? 'used' : /refurb/.test(cond) ? 'refurbished' : 'new',
    price: precioMeta(p.oldPrice || p.price),
    sale_price: p.oldPrice ? precioMeta(p.price) : '',
    link: urlSegura(p.link),
    additional_image_link: urlSegura(p.image),
    brand: textoPlano(p.brand).slice(0, 100),
    google_product_category: /^0*$/.test(String(r.google_product_category || '').trim()) ? '' : textoPlano(r.google_product_category), // Juntoz manda «0»
    product_type: textoPlano(r.product_type || '').slice(0, 750),
  };
  for (let i = 0; i <= 4; i++) fila['custom_label_' + i] = textoPlano(r['custom_label_' + i] || '').slice(0, 100);
  if (!fila.price) av.push('sin precio');
  if (!/^https?:\/\//.test(fila.link)) av.push('sin link');
  if (!fila.brand) av.push('sin marca');
  if (textoPlano(p.title).length > 200) av.push('título recortado a 200');
  return { fila, avisos: av };
}
