// Feed para Meta automático: lo que hace el bloque 5 de la Fábrica, pero con el catálogo completo
// y sin pantalla (la abre app/auto.js). Una pieza se vuelve a dibujar solo si cambió su «firma»:
// la plantilla, el formato, el código de dibujo (lienzo.js) o los datos del producto que salen en ella.
import { formatos } from './config.js';
import { leerFeed, filaMeta } from './feeds.js';
import { renderPng, SALIDA_FEED } from './lienzo.js';

const HILOS = 12, AVISO_CADA = 200;
const ESPERAS = [5000, 15000, 40000]; // reintentos de foto, en ms
// Cuando la tienda corta en seco (todas las fotos dan 502/503 en esa maquina) la espera creciente
// se vuelve una trampa: 60 s por producto, y una parte entera se va en horas antes de morir.
// Le paso el 2026-09-23 a la parte 6 de 8 de lacuracao/catalogo: 1.000 productos, 0 piezas
// dibujadas, 4 h en pie y la corrida completa perdida porque `unir` no llega a correr.
const RAFAGA = 10;        // fallos seguidos a partir de los cuales ya no se reintenta (no es transitorio)
const CORTE = 40;         // fallos seguidos = la tienda nos corto, no son fotos rotas sueltas
const PAUSA = 60e3;       // tregua antes de volver a intentar
const PAUSAS_MAX = 2;     // treguas permitidas; en el corte siguiente se abandona la parte
const params = new URLSearchParams(location.search), slug = params.get('slug') || '';
const limite = Number(params.get('limite')) || 0; // solo para pruebas: corta el feed a N productos
// Reparto en varias máquinas (app/publica.js): esta página dibuja los productos que le tocan.
// Por el sku y no por el número de orden: cada parte lee el feed por su cuenta, en su propia máquina
// y a su hora, así que si la tienda cambia el feed entre una lectura y otra, repartir por posición
// corre un lugar todo lo que viene después — productos que no dibuja nadie y otros dibujados dos
// veces. Con el sku, un producto cae siempre en la misma parte, lo lea quien lo lea.
// Sin estos parámetros, 0 de 1 = el catálogo entero, como siempre.
const parte = Number(params.get('parte')) || 0, de = Math.max(1, Number(params.get('de')) || 1);
// Con reparto, aunque sea de una sola parte, las filas van a `partes/` y el CSV lo escribe el paso de unir.
const repartido = params.has('parte');
// Hora tope para dibujar (la pone auto.js): lo que no alcance se dibuja en la próxima corrida.
const plazo = Number(params.get('plazo')) || Infinity;
const q = '?slug=' + encodeURIComponent(slug);
const log = t => { document.getElementById('log').textContent += '\n' + t; };
const hex = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
async function pedir(ruta, opt) {
  const r = await fetch(ruta, opt), d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return d;
}
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const progreso = t => { log(t); return fetch('/publicar/progreso' + q, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: t }).catch(() => {}); };

let cortado = false;
function cortar(e) {
  if (cortado) return; cortado = true;
  const error = String(e?.message || e || 'error desconocido');
  log('ERROR: ' + error);
  fetch('/publicar/auto-fin' + q, json({ error })).catch(() => {});
}
window.onerror = (m, f, l) => cortar(`${m} (${f}:${l})`);
window.onunhandledrejection = e => cortar(e.reason);

// Nombre de archivo = sku limpio + inicio de la firma: mismo producto y mismo diseño → mismo nombre.
const dondeVa = sku => { // FNV-1a: reparto estable y parejo a partir del sku
  const s = String(sku); let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % de;
};
const archivoDe = (sku, firma) => {
  let s = String(sku).replace(/[^\w.-]+/g, '-').slice(0, 90);
  if (!/^[A-Za-z0-9]/.test(s)) s = 'p' + s;
  return `${s}_${firma.slice(0, 12)}.jpg`;
};

async function correr() {
  const { receta, estado } = await pedir('/publicar/receta' + q);
  const fmt = formatos(receta.plantilla).find(f => f.id === receta.formato);
  if (!fmt) throw new Error('Formato no válido en la receta');
  const codigo = await (await fetch('js/lienzo.js', { cache: 'no-store' })).text();
  const phash = await hex(JSON.stringify(receta.plantilla) + '|' + fmt.id + '|' + fmt.w + 'x' + fmt.h + '|' + codigo);
  // Lo que ya está en el hosting (vigente o retirado hace poco) se reusa sin dibujar ni subir.
  const enHosting = new Set([...Object.values(estado.productos || {}).map(x => x[1]), ...Object.keys(estado.retirados || {})]);

  await progreso(`Leyendo el feed ${receta.feed_url}`);
  let prods;
  try { prods = await leerFeed(receta.feed_url); }
  catch (e) { // la tienda a veces tarda o corta: un segundo intento antes de rendirse
    await progreso(`El feed falló (${e.message}); reintento en 60 s`);
    await new Promise(r => setTimeout(r, 60000));
    prods = await leerFeed(receta.feed_url);
  }
  if (limite) prods = prods.slice(0, limite);
  if (de > 1) { const todos = prods.length; prods = prods.filter(p => dondeVa(p.sku) === parte); await progreso(`Parte ${parte} de ${de}: ${prods.length} de ${todos} productos`); }
  await progreso(`${prods.length} productos en el feed`);

  const fuera = { 'sin foto': 0, 'sin precio': 0, 'sin link': 0, 'repetidos': 0, 'pendientes': 0 }, cola = [], ids = new Set();
  for (const p of prods) {
    const { fila } = filaMeta(p);
    if (!p.image) { fuera['sin foto']++; continue; }
    if (!fila.price) { fuera['sin precio']++; continue; }
    if (!/^https?:\/\//.test(fila.link)) { fuera['sin link']++; continue; }
    if (ids.has(fila.id)) { fuera.repetidos++; continue; } // Meta no acepta dos filas con el mismo id
    ids.add(fila.id);
    const firma = await hex(phash + JSON.stringify([p.image, p.brand, p.title, p.price, p.oldPrice]));
    const pf = (await hex(JSON.stringify([p.price, p.oldPrice]))).slice(0, 16); // el precio que sale dibujado
    cola.push({ p, fila, firma, pf, archivo: archivoDe(p.sku, firma) });
  }

  const res = new Array(cola.length);
  let i = 0, hechas = 0, dibujadas = 0, atrasadas = 0;
  // Freno de tienda caida: lo comparten los hilos, asi una sola tregua los para a todos.
  let seguidas = 0, pausas = 0, tregua = null, bloqueada = false, saltadas = 0;
  async function frenar() {
    if (tregua) return tregua;
    if (++pausas > PAUSAS_MAX) {
      // La tienda corto a ESTA maquina (su WAF bloquea la IP entera del runner: todas las fotos dan
      // 502/503). Antes se tiraba la parte, y como `unir` exige que las 8 partes salgan bien, una sola
      // maquina bloqueada perdia la corrida completa y no se publicaba nada. Ahora la parte NO muere:
      // se deja de pedir fotos y cada producto que falta sale con su pieza anterior, que `anterior()`
      // solo devuelve si muestra el mismo precio. Asi el CSV se publica igual y la proxima corrida
      // (otra maquina, otra IP) redibuja lo que quedo con firma vieja. Solo cae el producto cuyo precio
      // cambio y cuya foto no se pudo bajar: uno suelto fuera del feed, no el feed entero.
      bloqueada = true;
      await progreso(`La tienda corto las fotos en esta maquina: se sigue con las piezas ya publicadas`);
      return;
    }
    tregua = (async () => {
      await progreso(`${CORTE} fotos seguidas fallaron: tregua de ${PAUSA / 60e3} min (pausa ${pausas} de ${PAUSAS_MAX})`);
      await new Promise(r => setTimeout(r, PAUSA));
      seguidas = 0; tregua = null;
    })();
    return tregua;
  }
  // Si no se puede dibujar ahora, se deja la pieza anterior solo si muestra el mismo precio
  // (cambió la plantilla o el título, no el precio). Queda con su firma vieja: la próxima corrida la rehace.
  const anterior = t => {
    const v = (estado.productos || {})[t.fila.id];
    if (v && v[2] === t.pf && enHosting.has(v[1])) { atrasadas++; return { ...t, firma: v[0], archivo: v[1] }; }
    return null;
  };
  async function hilo() {
    while (!cortado && i < cola.length) {
      // La tregua es de los dos hilos, no solo del que la pidio: si no, el otro sigue descargando
      // durante los 3 min, y una foto suya que salga bien pone `seguidas` en cero y borra el freno.
      if (tregua) { await tregua; continue; }
      const n = i++, t = cola[n];
      if (enHosting.has(t.archivo)) res[n] = t;
      else if (bloqueada) { res[n] = anterior(t); if (!res[n]) fuera['sin foto']++; saltadas++; }
      else if (Date.now() > plazo) { res[n] = anterior(t); if (!res[n]) fuera.pendientes++; }
      else {
        let { blob, sinFoto } = await renderPng(receta.plantilla, fmt, t.p, 'image/jpeg', SALIDA_FEED);
        // Las tiendas frenan muchas descargas seguidas (lacuracao.pe devuelve 502 y 503 en rachas).
        // Espera creciente, como el sistema que ya lleva 2 meses en producción (backoff 1,5):
        // con un solo reintento a los 5 s, una racha de 30 s dejaba el producto fuera del CSV.
        for (const espera of ESPERAS) {
          // En plena racha de fallos no se reintenta: esperar 60 s por producto solo alarga la agonia.
          if (!sinFoto || seguidas >= RAFAGA || tregua) break;
          await new Promise(r => setTimeout(r, espera));
          ({ blob, sinFoto } = await renderPng(receta.plantilla, fmt, t.p, 'image/jpeg', SALIDA_FEED));
        }
        if (sinFoto) { res[n] = anterior(t); if (!res[n]) fuera['sin foto']++; if (++seguidas >= CORTE) await frenar(); } // la foto no cargó: mejor fuera que una pieza vacía
        else {
          await pedir(`/publicar/auto-img${q}&archivo=${encodeURIComponent(t.archivo)}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
          dibujadas++; seguidas = 0; // la tienda responde: se reinicia el contador del freno
          res[n] = t;
        }
      }
      if (++hechas % AVISO_CADA === 0) progreso(`${hechas} de ${cola.length} (${dibujadas} dibujadas, ${fuera['sin foto']} sin foto)`);
    }
  }
  await Promise.all(Array.from({ length: HILOS }, hilo));
  if (cortado) return;
  if (bloqueada) await progreso(`Tienda bloqueada: ${saltadas} productos salieron con su pieza anterior`);

  const filas = res.filter(Boolean).map(t => ({ ...t.fila, _img: t.archivo, _firma: t.firma, _pf: t.pf }));
  if (!filas.length) throw new Error('Ningún producto quedó apto: ' + JSON.stringify(fuera) + ' (revisa fotos, precio y link)');
  await progreso(`Escribiendo el CSV: ${filas.length} productos, ${dibujadas} piezas nuevas`);
  const cuerpo = { filas, leidos: prods.length, fuera, atrasadas, dibujadas };
  // Repartido: cada parte deja sus filas y el CSV lo arma después el paso de unir (app/publica.js --unir).
  const ruta = repartido ? `/publicar/auto-parte${q}&parte=${parte}` : '/publicar/auto-feed' + q;
  const r = await pedir(ruta, json(cuerpo));
  log('LISTO ' + JSON.stringify(r));
}
correr().catch(cortar);
