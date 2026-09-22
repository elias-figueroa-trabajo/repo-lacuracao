# Feed de lacuracao para Meta y TikTok

Este repo dibuja las piezas del catálogo y publica el CSV. **No hay nada que descargar**: cada feed
tiene una URL fija que se sobrescribe sola en cada corrida.

    https://<dueño>.github.io/<repo>/<tienda>/<nombre>/feed.csv

Esa URL se pega **una sola vez** en el catálogo de Meta (o de TikTok) y ya no se vuelve a tocar.
Las imágenes viven en el mismo repo (`docs/<tienda>/<nombre>/img/`) y se sirven por GitHub Pages.

## Lo único que hay que configurar (una vez)

**Settings → Pages → Source: Deploy from a branch → Branch: `main`, carpeta `/docs`.**
No hace falta ningún secreto: el commit lo hace el token que GitHub da solo.

## Cómo corre

`.github/workflows/publica.yml`, cada hora en punto. Tres pasos:

1. **recetas**: qué feeds tocan esta hora (cada receta trae su horario en hora de Lima) y en cuántas partes.
2. **dibujar**: varias máquinas en paralelo. Cada una dibuja **solo lo que falta**: el nombre de la pieza
   lleva la firma del diseño y del precio, así que si ya está en `estado.json` ni se baja la foto.
   Esa copia del repo **no se trae las imágenes**, solo la lista: por eso arranca en segundos.
3. **unir**: una sola máquina junta las partes, escribe el CSV, borra lo que dejó de usarse hace más
   de 48 h y hace **un** commit. Si falló alguna parte no se publica nada y queda el CSV anterior:
   un feed al que le faltan productos hace que Meta los dé de baja.

También se puede disparar a mano en Actions → **Feeds a Pages** → Run workflow (con un `tienda/nombre`
para una sola, y opcionalmente en cuántas partes).

- Las recetas (`auto/recetas/<tienda>/<nombre>.json`) se crean y programan desde el panel «Mis feeds»
  de la Fábrica; el horario y el pausado van ahí, no en el workflow.
- Si el catálogo cae a menos de la mitad de golpe, no se publica (receta con `"permitir_caida": true`
  para forzarlo una vez).
