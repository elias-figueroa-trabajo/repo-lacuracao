// Consulta de productos en Magento (REST) para marketing.
// El token nunca llega al navegador: vive en <proyecto>/magento.env (fuera de
// app/, plantilla en magento.env.ejemplo) y este archivo pone la cabecera
// Authorization del lado del servidor. Claude no lee ni escribe ese archivo.
//
//   GET /magento/estado                         -> qué ambientes están configurados
//   GET /magento/producto?sku=A,B&amb=prod      -> productos normalizados
//
// Solo lectura, solo GET y solo desde la propia página.
const fs = require('fs');
const path = require('path');

const ENV = path.join(__dirname, '..', 'magento.env');
const AMBIENTES = { prod: 'PROD', staging: 'STAGING' };
const SKU_RE = /^[A-Za-z0-9._\-]{1,64}$/;
const MAX_SKUS = 50;

// Se relee en cada consulta: si el dueño edita el archivo no hay que reiniciar.
function config() {
  if (!fs.existsSync(ENV)) return null;
  const c = {};
  for (const linea of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) c[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return c;
}

function ambiente(c, amb) {
  const k = AMBIENTES[amb];
  if (!k || !c) return null;
  const base = String(c['MAGENTO_' + k + '_URL'] || '').replace(/\/+$/, '');
  const token = c['MAGENTO_' + k + '_TOKEN'] || '';
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base) || !token) return null;
  return { base, token };
}

// Etiquetas de atributos de selección (brand/marca/manufacturer vienen como id de opción).
// Se piden una vez por ambiente y se guardan 1 h: son pocas y casi nunca cambian.
const CACHE_OPC = new Map();
async function opciones(cfg, cod) {
  const k = cfg.base + '|' + cod, ya = CACHE_OPC.get(k);
  if (ya && Date.now() - ya.t < 3600e3) return ya.m;
  const m = new Map();
  try {
    const r = await fetch(cfg.base + '/rest/default/V1/products/attributes/' + cod + '/options', {
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (r.ok) for (const o of await r.json()) if (o && o.value) m.set(String(o.value), String(o.label || ''));
  } catch { /* si falla, se queda el id: mejor eso que romper la consulta */ }
  CACHE_OPC.set(k, { t: Date.now(), m });
  return m;
}

// Stock por SKU. Magento solo lo da de a uno (el buscador de productos devuelve
// stock_item vacío), así que va aparte y solo si la pantalla lo pide: son N pedidos.
async function stockDe(cfg, skus) {
  const m = new Map(), cola = skus.slice();
  const uno = async () => {
    for (let sku = cola.shift(); sku; sku = cola.shift()) {
      try {
        const r = await fetch(cfg.base + '/rest/default/V1/stockStatuses/' + encodeURIComponent(sku), {
          headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(20000)
        });
        if (!r.ok) continue;
        const d = await r.json();
        m.set(String(sku).toUpperCase(), { qty: Number(d.qty) || 0, en_stock: Number(d.stock_status) === 1 });
      } catch { /* ese SKU se queda sin dato y la tabla lo dice */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, skus.length) }, uno));
  return m;
}

const atributo = (p, cod) => {
  const a = (p.custom_attributes || []).find(x => x.attribute_code === cod);
  return a ? a.value : null;
};
const numero = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const textoPlano = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Precio especial solo si está vigente hoy (special_from_date / special_to_date).
function especialVigente(p, precio) {
  const sp = numero(atributo(p, 'special_price'));
  if (sp === null || precio === null || sp >= precio) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = String(atributo(p, 'special_from_date') || '').slice(0, 10);
  const hasta = String(atributo(p, 'special_to_date') || '').slice(0, 10);
  if (desde && desde > hoy) return null;
  if (hasta && hasta < hoy) return null;
  return sp;
}

function normalizar(p, base, etiquetas, stocks) {
  const precio = numero(p.price);
  const galeria = (p.media_gallery_entries || []).filter(m => m.media_type === 'image' && !m.disabled);
  const principal = galeria.find(m => (m.types || []).includes('image')) || galeria[0];
  const archivo = (principal && principal.file) || atributo(p, 'image') || '';
  const stockItem = p.extension_attributes && p.extension_attributes.stock_item;
  const msi = stocks && stocks.get(String(p.sku).toUpperCase());
  const stock = msi || (stockItem ? { qty: stockItem.qty, en_stock: !!stockItem.is_in_stock } : null);
  const marcaId = atributo(p, 'brand') || atributo(p, 'marca') || atributo(p, 'manufacturer') || '';
  return {
    sku: p.sku,
    name: p.name || '',
    price: precio,
    special_price: especialVigente(p, precio),
    special_price_bruto: numero(atributo(p, 'special_price')),
    special_from: atributo(p, 'special_from_date'),
    special_to: atributo(p, 'special_to_date'),
    image: archivo && archivo !== 'no_selection' ? base + '/media/catalog/product' + archivo : '',
    imagen_ruta: archivo && archivo !== 'no_selection' ? archivo : '',
    url_key: atributo(p, 'url_key') || '',
    status: p.status === 1 ? 'activo' : 'inactivo',
    visibility: p.visibility,
    type: p.type_id,
    brand: (etiquetas && etiquetas.get(String(marcaId))) || marcaId,
    stock: stock ? { qty: stock.qty, en_stock: !!stock.en_stock } : null,
    descripcion: textoPlano(atributo(p, 'short_description') || atributo(p, 'description')).slice(0, 400),
    actualizado: p.updated_at || ''
  };
}

async function magento(req, res, u, { local }) {
  const out = (code, d) => {
    if (res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(d));
  };
  // Solo GET, solo con Host local (corta DNS rebinding) y solo desde la propia página.
  if (req.method !== 'GET') return out(405, { error: 'Solo lectura' });
  const puerto = local.split(':').pop();
  if (!['localhost:' + puerto, '127.0.0.1:' + puerto].includes(String(req.headers.host || ''))) return out(403, { error: 'Host no permitido' });
  const sitio = req.headers['sec-fetch-site'];
  if (sitio && sitio !== 'same-origin' && sitio !== 'none') return out(403, { error: 'Origen no permitido' });

  const c = config();
  if (u.pathname === '/magento/estado') {
    return out(200, { archivo: !!c, prod: !!ambiente(c, 'prod'), staging: !!ambiente(c, 'staging') });
  }
  if (u.pathname !== '/magento/producto') return out(404, { error: 'No existe' });
  if (!c) return out(503, { error: 'Falta magento.env en la carpeta del proyecto (copia magento.env.ejemplo y pon los tokens).' });
  const amb = u.searchParams.get('amb') || 'prod';
  const cfg = ambiente(c, amb);
  if (!cfg) return out(503, { error: 'magento.env no tiene URL o token para ' + amb + '.' });

  const skus = [...new Set(String(u.searchParams.get('sku') || '').split(',').map(s => s.trim()).filter(Boolean))];
  if (!skus.length) return out(400, { error: 'Falta el SKU' });
  if (skus.length > MAX_SKUS) return out(400, { error: 'Máximo ' + MAX_SKUS + ' SKU por consulta' });
  const malos = skus.filter(s => !SKU_RE.test(s));
  if (malos.length) return out(400, { error: 'SKU con caracteres no válidos: ' + malos.slice(0, 5).join(', ') });

  const q = new URLSearchParams({
    'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
    'searchCriteria[filter_groups][0][filters][0][value]': skus.join(','),
    'searchCriteria[filter_groups][0][filters][0][condition_type]': 'in',
    'searchCriteria[pageSize]': String(MAX_SKUS)
  });
  try {
    const r = await fetch(cfg.base + '/rest/default/V1/products?' + q, {
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json', 'User-Agent': 'EFE-Martech-Fabrica/1.0' },
      redirect: 'error', signal: AbortSignal.timeout(30000)
    });
    const txt = await r.text();
    if (!r.ok) {
      let msg = '';
      try { msg = JSON.parse(txt).message || ''; } catch { /* no era JSON */ }
      const pista = r.status === 401 ? ' (token vencido o sin permiso de catálogo)' : '';
      return out(502, { error: 'Magento respondió ' + r.status + pista + (msg ? ': ' + msg.slice(0, 200) : '') });
    }
    const d = JSON.parse(txt);
    const conStock = u.searchParams.get('stock') === 'si';
    const [etiquetas, stocks] = await Promise.all([
      opciones(cfg, 'brand'),
      conStock ? stockDe(cfg, skus) : Promise.resolve(null)
    ]);
    const items = (d.items || []).map(p => normalizar(p, cfg.base, etiquetas, stocks));
    const vistos = new Set(items.map(i => String(i.sku).toUpperCase()));
    out(200, { amb, total: d.total_count ?? items.length, items, faltan: skus.filter(s => !vistos.has(s.toUpperCase())) });
  } catch (e) {
    out(502, { error: 'No se pudo consultar Magento: ' + (e.name === 'TimeoutError' ? 'tardó más de 30 s' : e.message) });
  }
}

module.exports = { magento };
