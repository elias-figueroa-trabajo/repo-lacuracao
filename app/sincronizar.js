// Subir cambios a GitHub desde el panel, sin abrir un .bat.
//
//   POST /publicar/sincronizar?tienda=lacuracao            arma repo-lacuracao/ y lo empuja
//   POST /publicar/sincronizar?tienda=lacuracao&ahora=1    además deja el pedido de «actualizar ahora»
//
// Hace lo mismo que SUBIR-REPO.bat (que se conserva para la primera vez, cuando hay que decir la URL
// del repo y entrar a la cuenta), pero para el día a día: guardar una receta o pedir una corrida ya
// no obliga a salir de la pantalla.
//
// El empujón es también el disparador: auto/ahora.json cambia → el workflow corre ese feed al instante
// (ver `on: push` en auto/publica.yml). Así no hace falta ningún token guardado en esta máquina.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const AHORA = path.join(RAIZ, 'auto', 'ahora.json');
const TIENDA = /^[a-z][a-z0-9-]{1,39}$/;
const ESPERA = 240e3; // 4 min: subir las recetas es rápido, pero la primera vez abre el navegador para entrar

const repoDir = tienda => path.join(RAIZ, 'repo-' + tienda);

// git sin shell (los argumentos van en una lista) y sin preguntas en consola: si pide usuario, falla y se avisa.
function git(dir, args, tolerante) {
  try {
    return { ok: true, salida: execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: ESPERA, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim() };
  } catch (e) {
    if (tolerante) return { ok: false, salida: String(e.stderr || e.stdout || e.message).trim() };
    throw new Error(limpiar(String(e.stderr || e.stdout || e.message)).slice(0, 600));
  }
}

// Nunca devolver una URL con usuario:clave (algunos remotos viejos la llevan dentro).
const limpiar = t => String(t).replace(/(https?:\/\/)[^@\s/]+@/gi, '$1');
function nombreRepo(url) {
  const m = limpiar(url).match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  return m ? m[1] + '/' + m[2] : '';
}
// Dirección que servirá GitHub Pages con Settings > Pages > main > /docs. Sale del nombre del repo,
// así que el panel sabe la URL pública sin que nadie la escriba en publicar.env.
function pagesDe(repo) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo || '');
  return m ? `https://${m[1].toLowerCase()}.github.io/${m[2]}` : '';
}

// Qué repos hay armados en el proyecto y cuáles ya están conectados a GitHub.
function estadoRepos(tiendas) {
  const out = {};
  for (const t of tiendas) {
    const d = repoDir(t);
    if (!fs.existsSync(path.join(d, '.git'))) { out[t] = { carpeta: fs.existsSync(d), conectado: false }; continue; }
    const r = git(d, ['remote', 'get-url', 'origin'], true);
    const repo = r.ok ? nombreRepo(r.salida) : '';
    out[t] = { carpeta: true, conectado: !!repo, repo, pages_url: pagesDe(repo),
      acciones_url: repo ? `https://github.com/${repo}/actions/workflows/publica.yml` : '' };
  }
  return out;
}

// Arma el repo de la tienda con lo que hay hoy (código, recetas y el pedido) y lo empuja.
function sincronizar(tienda, slugs) {
  if (!TIENDA.test(tienda)) throw new Error('Tienda no válida');
  // Sin slugs (guardar una receta, cambiar el horario) el pedido se borra: así una subida cualquiera
  // dentro de las 6 h no vuelve a disparar la corrida que ya se pidió antes.
  if (slugs && slugs.length) {
    fs.mkdirSync(path.dirname(AHORA), { recursive: true });
    fs.writeFileSync(AHORA, JSON.stringify({ pedido: new Date().toISOString(), slugs }, null, 1));
  } else fs.rmSync(AHORA, { force: true });
  // armar-repo.js valida y se planta si algo huele a clave; si falla, no se toca git.
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'armar-repo.js'), tienda],
      { cwd: RAIZ, encoding: 'utf8', timeout: ESPERA, windowsHide: true });
  } catch (e) {
    throw new Error('No se pudo armar el repo: ' + String(e.stdout || e.stderr || e.message).trim().slice(0, 600));
  }

  const d = repoDir(tienda);
  if (!fs.existsSync(path.join(d, '.git'))) {
    throw new Error(`repo-${tienda} todavía no está conectado a GitHub. Corre SUBIR-REPO.bat una vez (pide la URL del repo y te hace entrar a la cuenta); después este botón ya funciona solo.`);
  }
  const rem = git(d, ['remote', 'get-url', 'origin'], true);
  const repo = rem.ok ? nombreRepo(rem.salida) : '';
  if (!repo) throw new Error(`repo-${tienda} no tiene un remoto de GitHub. Corre SUBIR-REPO.bat una vez.`);

  // Quien manda en `docs/` es el workflow, que commitea allá en cada corrida; esta máquina
  // nunca hace `git pull` y su carpeta `docs/` está vacía a propósito (las piezas pesan GB).
  // Así que antes de empujar se reengancha a lo que hay en GitHub: se baja el árbol SIN los
  // blobs (`--filter=blob:none`, GitHub lo soporta), se planta HEAD sobre `origin/<rama>`
  // dejando el índice como está allá, y se agrega solo lo nuestro **excluyendo `docs`**.
  // De ese modo `docs/` del remoto se conserva intacto y el push deja de salir «fetch first».
  // Ojo: en un repo recien creado no hay `origin/<rama>` todavia, y entonces NO se puede excluir
  // `docs`: el `docs/.nojekyll` que hace falta para que Pages sirva la carpeta se quedaria fuera
  // del primer commit (le paso a repo-efe). Solo se excluye cuando alla ya hay algo que conservar.
  const rama0 = git(d, ['rev-parse', '--abbrev-ref', 'HEAD'], true).salida || 'main';
  const traido = git(d, ['fetch', '--filter=blob:none', 'origin', rama0], true);
  const hayRemoto = traido.ok && git(d, ['rev-parse', '--verify', 'origin/' + rama0], true).ok;
  if (hayRemoto) git(d, ['reset', '--mixed', 'origin/' + rama0], true);
  git(d, hayRemoto ? ['add', '-A', '--', '.', ':(exclude)docs'] : ['add', '-A']);
  // `docs/.nojekyll` es la unica cosa de `docs/` que manda esta maquina: sin el, Pages ignora
  // las carpetas que empiezan con `_` y no sirve nada. Se agrega aparte de la exclusion.
  if (fs.existsSync(path.join(d, 'docs', '.nojekyll'))) git(d, ['add', '-f', '--', 'docs/.nojekyll'], true);
  const hay = git(d, ['diff', '--cached', '--quiet'], true); // sale con error = sí hay cambios
  let commit = '';
  if (!hay.ok) {
    const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' });
    git(d, ['-c', 'user.name=Fábrica de piezas', '-c', 'user.email=elias.figueroa.trabajo@gmail.com',
      'commit', '-m', 'Recetas y pedido desde la Fábrica: ' + fecha]);
    commit = git(d, ['rev-parse', '--short', 'HEAD'], true).salida;
  }
  const rama = git(d, ['rev-parse', '--abbrev-ref', 'HEAD'], true).salida || 'main';
  const push = git(d, ['push', 'origin', 'HEAD:' + rama], true);
  if (!push.ok) {
    throw new Error('No se pudo subir a GitHub: ' + limpiar(push.salida).slice(0, 400)
      + ' · Si pide usuario o clave, corre SUBIR-REPO.bat una vez para entrar a la cuenta.');
  }
  return { ok: true, tienda, repo, commit, cambios: !hay.ok, pedido: !!(slugs && slugs.length),
    acciones_url: `https://github.com/${repo}/actions/workflows/publica.yml` };
}

module.exports = { sincronizar, estadoRepos, pagesDe, repoDir };
