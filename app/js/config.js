// Configuración de la app. Hoy todo corre en local (app/server.js).
// Al pasar a Supabase, el proxy será una Edge Function y aquí cambia solo esta línea.
const PROXY = '/proxy?url=';
// Una URL del propio sitio (/demo/x.svg) no pasa por el proxy: el proxy solo acepta dominios de PERMITIDOS y la rechazaba con 403.
export const proxied = url => url.startsWith('data:') || url.startsWith('blob:') || (url.startsWith('/') && !url.startsWith('//')) ? url : PROXY + encodeURIComponent(url);

// Formatos de salida. `id` va en el nombre del archivo.
export const FORMATOS = [
  { id: '1x1', n: 'Cuadrado 1:1', w: 1080, h: 1080 },
  { id: '4x5', n: 'Feed 4:5', w: 1080, h: 1350 },
  { id: '9x16', n: 'Historia 9:16', w: 1080, h: 1920 },
  { id: '3x1', n: 'Banner 3:1', w: 1200, h: 400 },
];

// Formato «Plantilla»: no está en la lista fija, nace de la imagen de fondo que se sube.
// El lienzo toma el tamaño real en píxeles de esa imagen, así la pieza sale del mismo
// tamaño que la plantilla diseñada fuera (Photoshop, Canva, Figma…) y la foto no se recorta.
// Tope para que un PNG enorme no reviente el lienzo ni la memoria del lote.
export const FMT_FONDO = 'fondo';
export const LADO_MAX = 4000;
export const fmtFondo = pl => {
  const w = Math.round(pl?.fondo?.w || 0), h = Math.round(pl?.fondo?.h || 0);
  if (!(w >= 50 && h >= 50 && w <= LADO_MAX && h <= LADO_MAX)) return null;
  return { id: FMT_FONDO, n: `Plantilla ${w}×${h}`, w, h };
};
// Formatos disponibles para una plantilla: los fijos y, si tiene fondo propio, el suyo.
export const formatos = pl => { const f = fmtFondo(pl); return f ? [...FORMATOS, f] : [...FORMATOS]; };

// C{AAMM}_{NOMBRE}_{ANUNCIANTE}, ver CLAUDE.md §4. Nunca se falsea.
export const CAMPAIGN_RE = /^C\d{2}(0[1-9]|1[0-2])_[A-Z0-9]+(_[A-Z0-9]+)?$/; // C + AAMM con mes real

// Marcas del grupo: n = nombre (igual al de campanas.marca), c = sigla del selector, x = color.
export const MARCAS_INFO = [
  { n: 'Tiendas EFE', c: 'EF', x: '#facc15' },
  { n: 'La Curacao', c: 'LC', x: '#ef4444' },
  { n: 'Motocorp', c: 'MC', x: '#f97316' },
  { n: 'Financiera Efectiva', c: 'FE', x: '#22c55e' },
  { n: 'Juntoz', c: 'JZ', x: '#a855f7' },
];
export const MARCAS = MARCAS_INFO.map(m => m.n);
// Marca con la que se está trabajando (selector al pie del menú). '' = todas.
// Marca de trabajo. Se valida contra MARCAS: si quedó guardada una marca retirada, el menú la
// pinta como «Todas las marcas» pero las pantallas seguirían filtrando por ella y no se vería
// ninguna campaña ni pedido. El valor vive también en memoria para que, si localStorage falla
// (incógnito, cuota), lo que se pinta y lo que se filtra no se separen.
let marcaMem = null;
export const marcaActual = () => {
  if (marcaMem === null) { try { marcaMem = localStorage.getItem('efe_marca') || ''; } catch { marcaMem = ''; } }
  return MARCAS.includes(marcaMem) ? marcaMem : '';
};
// Única puerta de escritura: devuelve la marca que realmente quedó puesta.
export const guardarMarca = m => {
  marcaMem = MARCAS.includes(m) ? m : '';
  try { localStorage.setItem('efe_marca', marcaMem); } catch {}
  return marcaMem;
};
