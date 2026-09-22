// Publica un feed a GitHub Pages: las piezas viven en el propio repo y el CSV queda en una URL fija
// que se sobrescribe cada corrida. No hay ZIP, ni FTP, ni artefacto que descargar: se pega la URL
// una vez en Meta (o TikTok) y ya nunca más se toca.
//
//   node app/publica.js <tienda/nombre> --parte K --de N   dibuja 1 de cada N productos
//   node app/publica.js <tienda/nombre> --unir --de N      une las partes, escribe feed.csv y poda
//   node app/publica.js <tienda/nombre>                    todo de una (catálogos chicos, o en local)
//
// Todo se escribe dentro de PAGES_DIR (por defecto `docs/`, que es una de las dos carpetas que GitHub
// Pages sabe servir sin configurar nada raro: Settings > Pages > Branch main, carpeta /docs):
//   docs/<tienda>/<nombre>/img/*.jpg   las piezas
//   docs/<tienda>/<nombre>/feed.csv    la URL que se da de alta en Meta/TikTok
//   docs/<tienda>/<nombre>/estado.json qué pieza corresponde a qué producto (el «ya lo tengo» del caché)
// El commit y el push los hace el workflow (auto/publica.yml), en un solo job, para que dos partes
// no se pisen empujando a la vez.
//
// La URL pública sale sola del repo en Actions (https://<dueño>.github.io/<repo>); en local se puede
// forzar con la variable PAGES_URL.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const RECETAS = path.join(RAIZ, 'auto', 'recetas');
const PAGES = path.resolve(process.env.PAGES_DIR || path.join(RAIZ, 'docs'));
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}\/[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const ESPERA_MAX = 6 * 3600e3;  // red de seguridad: la página deja de dibujar antes (PLAZO_MIN)
const GRACIA = 48 * 3600e3;     // una pieza retirada se borra del repo recién a las 48 h
const CI = !!process.env.GITHUB_ACTIONS;

const arg = process.argv.slice(2);
const opcion = n => { const i = arg.indexOf(n); return i >= 0 ? arg[i + 1] : undefined; };
const CON_VALOR = ['--parte', '--de', '--limite', '--puerto', '--plazo'];
const UNIR = arg.includes('--unir');
const PARTE = Number(opcion('--parte')) || 0;
const DE = Math.max(1, Number(opcion('--de')) || 1);
const LIMITE = Number(opcion('--limite')) || 0;
const PUERTO = Number(opcion('--puerto')) || 5192;
const PLAZO_MIN = Number(opcion('--plazo')) || 300;

const dormir = ms => new Promise(r => setTimeout(r, ms));
const leerJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const hora = () => new Date().toISOString().slice(11, 19);
const decir = (slug, t) => console.log(`${hora()} [${slug}] ${t}`);
const dirSlug = slug => path.join(PAGES, slug);

function buscarChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const win = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  if (process.platform === 'win32') { const f = win.find(x => fs.existsSync(x)); if (f) return f; }
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [n], { encoding: 'utf8' }).trim(); } catch { /* sigue */ }
  }
  throw new Error('No se encontró Chrome ni Edge (se puede indicar con la variable CHROME)');
}

// El mismo servidor de la Fábrica, en otro puerto y apuntando a la carpeta de Pages.
async function levantarServidor() {
  const env = { ...process.env, PORT: String(PUERTO), FEEDS_AUTO: 'no', PAGES_DIR: PAGES };
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  srv.stdout.on('data', d => process.stdout.write(String(d).replace(/^(?=.)/gm, '  ')));
  srv.stderr.on('data', d => process.stderr.write(String(d).replace(/^(?=.)/gm, '  ! ')));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PUERTO}/publicar/estado`)).ok) return srv; } catch { /* aún no */ }
    if (srv.exitCode != null) break;
    await dormir(200);
  }
  srv.kill();
  throw new Error('El servidor local no arrancó en el puerto ' + PUERTO);
}

async function pedir(ruta, cuerpo) {
  // El servidor solo acepta escrituras de su propia página (ctxLocal en server.js): hay que decir de dónde viene.
  const origen = `http://127.0.0.1:${PUERTO}`;
  const r = await fetch(origen + ruta, cuerpo === undefined ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origen }, body: JSON.stringify(cuerpo) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return d;
}

// ---------- dibujar (una parte, o el catálogo entero si no hay reparto) ----------
async function dibujar(slug, chrome) {
  const d = dirSlug(slug), fin = path.join(d, 'fin.json');
  fs.rmSync(fin, { force: true });
  fs.mkdirSync(path.join(d, 'img'), { recursive: true }); // OJO: no se vacía; ahí vive el caché del repo
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'efe-pages-'));
  const url = `http://127.0.0.1:${PUERTO}/auto.html?slug=${encodeURIComponent(slug)}`
    + `&plazo=${Date.now() + PLAZO_MIN * 60e3}${LIMITE ? '&limite=' + LIMITE : ''}`
    + (DE > 1 ? `&parte=${PARTE}&de=${DE}` : '');
  const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + perfil];
  if (CI) flags.push('--no-sandbox', '--disable-dev-shm-usage');
  const nav = spawn(chrome, [...flags, url], { stdio: 'ignore', windowsHide: true });
  let salio = false; nav.on('exit', () => { salio = true; });
  try {
    const t0 = Date.now();
    while (!fs.existsSync(fin)) {
      if (salio) throw new Error('El navegador se cerró antes de terminar');
      if (Date.now() - t0 > ESPERA_MAX) throw new Error('Pasaron 6 h sin terminar');
      await dormir(2000);
    }
    await dormir(300); // que termine de escribirse
    return leerJson(fin, { ok: false, error: 'fin.json ilegible' });
  } finally {
    nav.kill();
    await dormir(500);
    fs.rmSync(perfil, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ---------- unir: CSV definitivo, estado y poda ----------
// Solo corre una vez por feed, en un job aparte. Si falta una parte el servidor devuelve 409 y no se
// publica nada: mejor el feed de la corrida anterior que uno al que le faltan productos.
async function unir(slug) {
  const r = await pedir(`/publicar/auto-unir?slug=${encodeURIComponent(slug)}&de=${DE}`, {});
  return { ...r, ...cerrarEstado(slug) };
}

// Pasa estado.nuevo.json a estado.json y borra del repo lo retirado hace más de 48 h.
function cerrarEstado(slug) {
  const d = dirSlug(slug);
  const estado = leerJson(path.join(d, 'estado.nuevo.json'), null);
  if (!estado) throw new Error('No se escribió estado.nuevo.json');

  // El estado sale sin los vencidos ANTES de borrarlos: si el borrado falla quedan huérfanos (no molesta);
  // al revés, un estado viejo los daría por existentes y se reusaría una imagen ya borrada.
  const ahora = Date.now();
  const vencidos = Object.entries(estado.retirados).filter(([, f]) => ahora - Date.parse(f) > GRACIA).map(([a]) => a);
  for (const a of vencidos) delete estado.retirados[a];
  fs.writeFileSync(path.join(d, 'estado.json'), JSON.stringify(estado));
  for (const a of vencidos) fs.rmSync(path.join(d, 'img', a), { force: true });
  fs.rmSync(path.join(d, 'estado.nuevo.json'), { force: true });
  for (const f of ['partes', 'fin.json', 'manual.log']) fs.rmSync(path.join(d, f), { recursive: true, force: true }); // trabajo interno: no va al repo
  return { borradas: vencidos.length, en_espera: Object.keys(estado.retirados).length };
}

async function main() {
  const slug = arg.find((a, i) => !a.startsWith('--') && !CON_VALOR.includes(arg[i - 1]));
  if (!slug || !SLUG.test(slug)) throw new Error('Uso: node app/publica.js <tienda/nombre> [--parte K --de N | --unir --de N]');
  if (!fs.existsSync(path.join(RECETAS, slug + '.json'))) throw new Error('No hay receta auto/recetas/' + slug + '.json');
  if (PARTE >= DE) throw new Error(`--parte ${PARTE} no existe con --de ${DE}`);
  fs.mkdirSync(dirSlug(slug), { recursive: true });

  const srv = await levantarServidor();
  let r;
  try {
    const { ftp_url: _f, ...est } = await pedir('/publicar/estado');
    if (!est.pages_url) throw new Error('Falta PAGES_URL: la raíz pública del repo (en Actions sale sola del repo)');
    decir(slug, 'Publica en ' + est.pages_url + '/' + slug + '/feed.csv');
    if (UNIR) r = await unir(slug);
    else {
      const t0 = Date.now();
      const chrome = buscarChrome();
      decir(slug, `Navegador: ${chrome}${DE > 1 ? ` · parte ${PARTE} de ${DE}` : ''}`);
      r = await dibujar(slug, chrome);
      if (!r.ok) throw new Error(r.error);
      decir(slug, `Dibujo listo en ${Math.round((Date.now() - t0) / 60e3)} min: ${JSON.stringify(r)}`);
      // Sin reparto, auto-feed ya dejó el CSV: falta cerrar el estado y podar, igual que al unir.
      if (DE === 1) r = { ...r, ...cerrarEstado(slug) };
    }
  } finally { srv.kill(); }

  const paso = UNIR ? 'Unir' : DE > 1 ? `Parte ${PARTE} de ${DE}` : 'Corrida completa';
  const resumen = ['| Feed | Paso | Productos | Nuevas | Reusadas | Retiradas | Borradas |', '|---|---|---|---|---|---|---|',
    `| ${slug} | ${paso} | ${r.productos ?? r.filas ?? '-'} | ${r.nuevas ?? '-'} | ${r.reusadas ?? '-'} | ${r.retiradas ?? '-'} | ${r.borradas ?? '-'} |`].join('\n');
  console.log('\n' + resumen);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Feed a Pages\n\n' + resumen + '\n');
  decir(slug, 'Listo ' + JSON.stringify(r));
}

main().catch(e => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
