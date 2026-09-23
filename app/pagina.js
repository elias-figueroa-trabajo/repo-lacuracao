// Página pública de cada feed: el log de cambios que se ve en la misma URL donde vive el CSV.
//
//   docs/<tienda>/<nombre>/historial.json   las últimas 60 corridas (lo escribe app/publica.js)
//   docs/<tienda>/<nombre>/index.html       esa lista, legible, con la URL del feed y «Actualizar ahora»
//   docs/index.html                         portada del repo: todos los feeds de esta tienda
//
// Se escribe en el mismo paso que el CSV, así el commit del workflow ya la lleva. Sin dependencias:
// es HTML plano, para que GitHub Pages lo sirva tal cual.
const fs = require('fs');
const path = require('path');

const TOPE = 60; // corridas que se guardan en el historial
const leerJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lima = iso => { try { return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; } };
const n = v => (v == null || v === '' ? '–' : String(v));

const CSS = `:root{color-scheme:light dark;--f:#0f172a;--s:#64748b;--l:#e2e8f0;--b:#fff;--a:#7c3aed;--ok:#059669}
@media(prefers-color-scheme:dark){:root{--f:#e2e8f0;--s:#94a3b8;--l:#1e293b;--b:#0b1120;--a:#a78bfa;--ok:#34d399}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--b);color:var(--f);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.caja{max-width:860px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--s);text-transform:uppercase;letter-spacing:.05em}
a{color:var(--a)}p{margin:6px 0}.gris{color:var(--s)}
.url{display:block;word-break:break-all;background:var(--l);border-radius:8px;padding:10px 12px;font:13px/1.4 ui-monospace,Consolas,monospace;margin:8px 0}
.btn{display:inline-block;border:1px solid var(--l);border-radius:8px;padding:8px 14px;margin:4px 6px 4px 0;text-decoration:none;color:var(--f);background:transparent;font:inherit;cursor:pointer}
.btn.p{background:var(--a);border-color:var(--a);color:#fff}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--l);white-space:nowrap}
th{color:var(--s);font-weight:600}td.num,th.num{text-align:right}tr.mal td{color:#dc2626}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;background:var(--l)}.pill.ok{background:var(--ok);color:#fff}
footer{margin-top:32px;color:var(--s);font-size:13px}`;

const copiar = `<script>document.addEventListener('click',function(e){var b=e.target.closest('[data-c]');if(!b)return;
navigator.clipboard.writeText(b.dataset.c).then(function(){var t=b.textContent;b.textContent='Copiada';setTimeout(function(){b.textContent=t},1500)})});<\/script>`;

const marco = (titulo, cuerpo) => `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(titulo)}</title><style>${CSS}</style><div class="caja">${cuerpo}</div>${copiar}
`;

// Suma una corrida al historial y devuelve la lista completa (la más nueva primero).
function anotar(dirFeed, entrada) {
  const f = path.join(dirFeed, 'historial.json');
  const h = leerJson(f, []);
  const lista = (Array.isArray(h) ? h : []).filter(x => x && x.cuando);
  lista.unshift({ cuando: new Date().toISOString(), ...entrada });
  const corto = lista.slice(0, TOPE);
  fs.writeFileSync(f, JSON.stringify(corto, null, 1));
  return corto;
}

// Página de un feed: URL para Meta, estado y las últimas corridas.
function paginaFeed(dirFeed, slug, urlFeed, repo, historial) {
  const ult = historial[0] || {};
  const acciones = repo ? `https://github.com/${repo}/actions/workflows/publica.yml` : '';
  const filas = historial.map(h => `<tr class="${h.error ? 'mal' : ''}"><td>${esc(lima(h.cuando))}</td>
    <td class="num">${n(h.productos)}</td><td class="num">${n(h.nuevas)}</td><td class="num">${n(h.reusadas)}</td>
    <td class="num">${n(h.retiradas)}</td><td class="num">${n(h.borradas)}</td><td>${esc(h.error || h.paso || '')}</td></tr>`).join('');
  return marco(slug + ' · feed', `
<h1>${esc(slug)}</h1>
<p class="gris">Catálogo dibujado con la plantilla guardada. Esta dirección no cambia nunca: se da de alta
una sola vez en Meta o TikTok y se sobrescribe sola en cada corrida.</p>
<div class="url">${esc(urlFeed)}</div>
<p><button class="btn p" data-c="${esc(urlFeed)}">Copiar URL</button>
<a class="btn" href="feed.csv">Ver el CSV</a>
${acciones ? `<a class="btn" href="${esc(acciones)}" target="_blank" rel="noopener">Actualizar ahora (GitHub → Run workflow)</a>` : ''}</p>
<p><span class="pill ok">${n(ult.productos)} productos</span> <span class="pill">última corrida: ${esc(lima(ult.cuando)) || 'sin datos'}</span></p>
<h2>Log de cambios</h2>
<table><thead><tr><th>Cuándo (Lima)</th><th class="num">Productos</th><th class="num">Nuevas</th>
<th class="num">Reusadas</th><th class="num">Retiradas</th><th class="num">Borradas</th><th>Nota</th></tr></thead>
<tbody>${filas || '<tr><td colspan="7" class="gris">Todavía no hay corridas.</td></tr>'}</tbody></table>
<footer><p><a href="../../">Todos los feeds de este repo</a></p>
<p>«Nuevas» son las piezas que se dibujaron en esta corrida; «reusadas», las que ya estaban con el mismo
diseño y el mismo precio. «Retiradas» salieron del catálogo y se borran del repo a las 48 h.</p></footer>`);
}

// Portada del repo: un renglón por feed publicado (se rearma leyendo las carpetas de docs/).
function portada(pages, repo) {
  const feeds = [];
  for (const t of fs.existsSync(pages) ? fs.readdirSync(pages, { withFileTypes: true }) : []) {
    if (!t.isDirectory() || t.name.startsWith('.')) continue;
    for (const nb of fs.readdirSync(path.join(pages, t.name), { withFileTypes: true })) {
      if (!nb.isDirectory()) continue;
      const d = path.join(pages, t.name, nb.name);
      if (!fs.existsSync(path.join(d, 'feed.csv'))) continue;
      const est = leerJson(path.join(d, 'estado.json'), {});
      feeds.push({ slug: t.name + '/' + nb.name, productos: Object.keys(est.productos || {}).length, cuando: est.actualizado || '' });
    }
  }
  feeds.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const filas = feeds.map(f => `<tr><td><a href="${esc(f.slug)}/">${esc(f.slug)}</a></td>
    <td class="num">${f.productos}</td><td>${esc(lima(f.cuando))}</td>
    <td><a href="${esc(f.slug)}/feed.csv">feed.csv</a></td></tr>`).join('');
  fs.writeFileSync(path.join(pages, 'index.html'), marco('Feeds para Meta', `
<h1>Feeds para Meta y TikTok</h1>
<p class="gris">Cada feed se regenera solo en el horario que tenga puesto y se publica siempre en la misma
dirección.${repo ? ` Corre en <a href="https://github.com/${esc(repo)}/actions/workflows/publica.yml" target="_blank" rel="noopener">GitHub Actions</a>.` : ''}</p>
<table><thead><tr><th>Feed</th><th class="num">Productos</th><th>Última corrida (Lima)</th><th>CSV</th></tr></thead>
<tbody>${filas || '<tr><td colspan="4" class="gris">Todavía no hay feeds publicados.</td></tr>'}</tbody></table>`));
  return feeds.length;
}

// Lo que llama publica.js al terminar una corrida: anota, arma la página del feed y rehace la portada.
function escribirPaginas(pages, slug, urlFeed, repo, entrada) {
  const d = path.join(pages, slug);
  const historial = anotar(d, entrada);
  fs.writeFileSync(path.join(d, 'index.html'), paginaFeed(d, slug, urlFeed, repo, historial));
  portada(pages, repo);
  return historial.length;
}

module.exports = { escribirPaginas, portada };
