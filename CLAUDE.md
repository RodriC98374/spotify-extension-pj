# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Extensión personal de VS Code en TypeScript para controlar Spotify, buscar canciones y ver la letra sincronizada en tiempo real. Es de uso propio: se instala como `.vsix` y no se publica en el Marketplace.

No reproduce audio. Controla por Web API el dispositivo activo del usuario (cuenta Premium; normalmente el celular con audífonos Bluetooth). Los textos de UI y los comentarios de código van en español; los identificadores, en inglés.

## Forma de trabajo: por etapas

Se construye en cinco etapas. Al terminar cada una hay que detenerse para que el usuario la pruebe con F5; no se adelanta trabajo de etapas posteriores. Si un requisito es ambiguo, se pregunta antes de asumir.

1. Estructura del proyecto, `package.json` (comandos, ajustes, activationEvents) y login PKCE funcionando.
2. Barra de estado, controles de reproducción y manejo de "sin dispositivo activo".
3. Búsqueda con QuickPick.
4. Letras sincronizadas: parser LRC, polling + interpolación, webview, offset.
5. Empaquetado con `vsce package` y README corto con instrucciones de configuración.

Ampliaciones pedidas después, en este orden:

6. Biblioteca: Tus me gusta y playlists, en árbol lateral y en QuickPick.
7. Más aciertos de letra exprimiendo LRCLIB (búsqueda libre, otros artistas de la canción).
8. Letra traducida al español junto a la original, con un servicio de traducción gratuito.

**Etapa actual:** 1 a 6 probadas y aceptadas por el usuario; la siguiente es la 7. El 404 "Not found." (ver Controles) no volvió a aparecer en sus pruebas, pero su causa no quedó confirmada. Actualizar esta línea al cerrar cada etapa.

Sobre la etapa 8: no existe una fuente gratuita de letras ya traducidas (LRCLIB no las guarda; Musixmatch exige clave), así que será traducción automática. Hay que preguntar al usuario qué servicio prefiere antes de construirla.

## Repositorio público

El repositorio es público. **No se sube información sensible**, ni en archivos ni en mensajes de commit: nada de rutas locales, nombres de equipos, usuarios o dispositivos, correos, nombres reales, Client ID ni tokens. Lo que sea propio del equipo del usuario vive fuera del repo, en la memoria local de Claude, y no en este archivo.

Antes de cada commit hay que revisar el diff con ese criterio. La identidad de git de este repo está fijada con `git config --local`; no se cambia ni se usa la global. Solo se hace commit o push cuando el usuario lo pide.

## Entorno

- **Node ≥ 22** para empaquetar: `@vscode/vsce` 4 lo exige. esbuild y `tsc` funcionan también con versiones anteriores.
- **VS Code ≥ 1.140.** Probado con 1.141, cuyo extension host corre Node 24: `fetch`, `AbortSignal.timeout` y `node:crypto` están disponibles sin dependencias. `engines.vscode` es `^1.140.0` porque 1.140.0 es la última versión publicada de `@types/vscode`.
- **TypeScript 7** solo verifica tipos (`noEmit`); el JavaScript lo genera esbuild.

## Comandos

- `npm install`
- `npm run check-types`: `tsc --noEmit`.
- `npm run build`: bundle de desarrollo en `dist/extension.js`, con sourcemap.
- `npm run watch`: rebuild incremental.
- `npm run package`: verifica tipos y genera el bundle minificado. Es el `vscode:prepublish`.
- **F5** ("Run Extension") abre el Extension Development Host. Su tarea previa, `watch` en `.vscode/tasks.json`, usa el `node` del PATH.
- `npm run vsix`: genera `spotify-local-<versión>.vsix` con `vsce` vía `npx`, sin añadirlo como dependencia. Deja en `dist/` el bundle minificado; `npm run build` o F5 restauran el de desarrollo.

No hay tests ni linter configurados.

## Reglas fijas

- Nunca usar ni pedir Client Secret. El Client ID se lee del ajuste `spotifyLocal.clientId`.
- Solo Web API oficial de Spotify y LRCLIB. Nada de APIs internas o no documentadas: ni `sp_dc`, ni endpoints de letras de Spotify.
- Cero dependencias de runtime. `fetch` nativo, sin librerías de OAuth ni clientes HTTP.
- Redirect URI fijo `http://127.0.0.1:8888/callback`, registrado en el Developer Dashboard. Spotify no acepta `localhost`. Si el puerto 8888 está ocupado se informa el error; no se cambia de puerto.
- Scopes de reproducción: `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`. Scopes de biblioteca, solo lectura: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`. No se piden más sin que el usuario lo apruebe: cada scope nuevo le obliga a iniciar sesión otra vez.
- Los tokens viven solo en `context.secrets` y nunca se escriben en el log.

## Arquitectura

`src/extension.ts` compone todo y esbuild lo empaqueta en un único `dist/extension.js` (CJS, `vscode` externo). `extensionKind: ["ui"]` hace que la extensión corra siempre en la máquina local, que es donde debe escuchar el servidor del callback.

- `src/auth/`: OAuth 2.0 Authorization Code con PKCE. `AuthManager.login()` levanta el servidor temporal en 127.0.0.1:8888 antes de abrir el navegador, valida `state`, canjea el `code` y cierra el servidor pase lo que pase. Si `openExternal` devuelve `false` (el usuario descartó el diálogo de VS Code o eligió "Copiar"), el login no se aborta: se ofrece copiar la URL y el servidor sigue escuchando. `getAccessToken()` renueva de forma perezosa cuando al access token le quedan menos de 60 s, y las renovaciones concurrentes comparten una sola petición. `TokenStore` cachea SecretStorage y se invalida con `secrets.onDidChange`, porque otra ventana de VS Code puede haber rotado el refresh token.
- `src/spotify/client.ts`: `SpotifyClient` es el único punto que llama a `api.spotify.com`. Añade el bearer; ante un 401 renueva y reintenta una vez; ante un 429 guarda el `Retry-After` y rechaza las peticiones siguientes con `RateLimitError` hasta que pase el plazo. Los errores de la API llegan como `SpotifyApiError` con `status` y `reason` (por ejemplo `NO_ACTIVE_DEVICE`), y cada respuesta de error queda en el log con nivel `warn`: método, ruta, estado y mensaje, sin query ni cuerpo.
- `src/spotify/player.ts`: `Player` envuelve los endpoints de `/me/player`. Todos los comandos aceptan un `deviceId` opcional.
- `src/spotify/playbackMonitor.ts`: `PlaybackMonitor` es la única fuente del estado de reproducción. Hace el polling a `GET /me/player` (3 s sonando y con foco; 30 s en cualquier otro caso; lo que pida `Retry-After` tras un 429), publica cada lectura por `onDidChange` y nunca lanza. Cada canción nueva que informa Spotify queda en el log ("Suena «…»", con el modo aleatorio si está activado): es la forma de saber qué sonó de verdad tras un comando. Tras un comando, `patch()` refleja el cambio al instante y `refreshSoon()` adelanta la siguiente lectura. `lastReadAt` es el instante local al que corresponde el `progress_ms` de la última lectura real (el punto medio de la petición) y no cambia con `patch()`.
- `src/spotify/search.ts`: `searchTracks()` consulta `GET /search`.
- `src/spotify/library.ts`: `Library` lee las playlists (`GET /me/playlists`), sus canciones (`GET /playlists/{id}/items`) y Tus me gusta (`GET /me/tracks`), de 50 en 50, con caché en memoria que comparten el árbol y el QuickPick. Antes de pedir nada comprueba que la sesión tenga los scopes de biblioteca y, si no, lanza `MissingScopeError`, que `showError()` convierte en una invitación a iniciar sesión de nuevo.
- `src/lyrics/lrc.ts`: `parseLrc()`, sin dependencias.
- `src/lyrics/lrclib.ts`: `LyricsSource` pide la letra a LRCLIB (`/get` y, si no hay coincidencia, `/search` con el título tal cual y luego sin añadidos como "- Remastered 2011") y la cachea por track ID. De `/search` solo se aceptan tiempos de versiones cuya duración difiera 3 s como mucho; si no hay ninguna, se usa el texto sin sincronizar.
- `src/lyrics/lyricsSync.ts`: `LyricsSync` escucha al monitor, carga la letra al cambiar de canción y calcula la línea actual. Guarda un ancla (posición, instante) que cada lectura real reemplaza; entre lecturas interpola con un temporizador de 200 ms que se acorta para caer justo en el cambio de línea. Un cambio que llega por `patch()` no trae posición fiable: solo detiene o arranca el reloj. Una corrección menor de 400 ms no hace retroceder la línea. Al llegar el final previsto de la canción pide al monitor una lectura adelantada, una sola vez.
- `src/ui/deviceGuard.ts`: `DeviceGuard.run()` es el paso obligado de todo comando que mande algo al reproductor: resuelve la falta de dispositivo activo y el 404 sin motivo, y reintenta una vez.
- `src/ui/libraryView.ts`, `libraryPicker.ts` y `libraryCommands.ts`: el árbol "Biblioteca", el QuickPick en dos pasos y los handlers que ambos comparten. Los elementos del árbol disparan comandos `spotifyLocal.internal.*`, registrados pero sin declarar en `package.json` para que no salgan en la paleta. El árbol queda vacío sin sesión o sin permiso, y entonces VS Code muestra el `viewsWelcome` que corresponde a la clave de contexto `spotifyLocal.library` (`loggedOut`, `needsPermission` o `ready`).
- `src/ui/`: `statusBar.ts` pinta la barra a partir de (sesión, estado); `playbackCommands.ts` contiene los handlers de los comandos de reproducción y de búsqueda; `quickPicks.ts`, los selectores de dispositivo, volumen y canción. `pickTrack()` hace el debounce (350 ms, mínimo 2 caracteres), descarta las respuestas atrasadas y marca cada resultado con `alwaysShow` para que el filtro propio del QuickPick no oculte lo que Spotify devolvió. `lyricsView.ts` es el `WebviewViewProvider` de la letra: el HTML y su script van en línea con CSP por nonce y el webview solo pinta lo que recibe (`content` con todas las líneas, `active` con el índice). Al ocultarse la vista su contenido se destruye; cuando vuelve, el script envía `ready` y recibe el estado completo. `showError()` en `notifications.ts` convierte los errores conocidos en avisos con acción (abrir ajustes, iniciar sesión).
- `src/errors.ts`: `describeError()` da el texto legible de cualquier error, incluidos los fallos de red de `fetch`.

Los handlers se registran en `extension.ts` a través de un `register()` común que captura cualquier error, lo escribe en el canal de salida "Spotify Local" y lo pasa a `showError()`. Un handler nuevo solo tiene que lanzar.

## Requisitos por función

### Controles (etapa 2)

- Botón de modo aleatorio, pedido por el usuario el 2026-10-08: va entre "siguiente" y la canción, y alterna con `PUT /me/player/shuffle`. Los codicons no tienen icono de aleatorio: se usa `$(arrow-swap)` si está activado y `$(list-ordered)` si se reproduce en orden. Solo se muestra cuando `GET /me/player` trae `shuffle_state`.
- Barra de estado: anterior, play/pausa, siguiente, el texto "artista – canción" y un botón de volumen con el % actual que abre un QuickPick de niveles (0 a 100 en pasos de 10). Los comandos Subir y Bajar volumen (±10) existen para asignarles atajos.
- Sin dispositivo activo: detectar el 404 con `reason: NO_ACTIVE_DEVICE`, avisar y ofrecer transferir la reproducción a uno de los dispositivos del usuario (`GET /me/player/devices` + `PUT /me/player`). Implementado en `DeviceGuard.run()`: transfiere con `play: false`, espera 700 ms y reintenta el comando original con `device_id`, porque la transferencia es asíncrona y el dispositivo puede no figurar aún como activo. Todo comando que mande algo al reproductor, la búsqueda y la biblioteca incluidas, pasa por `DeviceGuard.run()`.
- **404 sin `reason`, mensaje "Not found."**: el usuario lo recibió el 2026-10-08 en `play` y en `next` con el celular como dispositivo. Spotify no dice qué no encontró. Como falló también `next`, que no nombra ninguna canción, se trata como un dispositivo que figura activo pero ya no recibe órdenes; es una hipótesis, no está confirmada contra Spotify real. `DeviceGuard.run()` pide los dispositivos, vuelve a transferir la reproducción al que figura activo (o al único que haya; solo pregunta si hay varios y ninguno activo), espera 700 ms y reintenta con `device_id`. Si vuelve a fallar, el mensaje pide abrir Spotify en el dispositivo y reproducir algo ahí. Si el usuario vuelve a ver ese mensaje con el celular despierto, la causa es otra y hay que mirar las líneas `warn` del log.
- Spotify solo lista un dispositivo cuando su app está abierta y conectada. Un celular con la app recién abierta puede tardar en aparecer o no figurar hasta que reproduce algo; en ese caso `GET /me/player/devices` llega vacío y no hay nada que la extensión pueda hacer salvo avisar.
- El objeto device trae `supports_volume`. El celular con el que se probó lo reporta en `false` y Spotify rechaza el cambio con 403 "Cannot control device volume"; se comprobó el 2026-10-08 y no hay otra vía oficial. Por eso el botón de volumen de la barra solo se muestra cuando el dispositivo activo declara `supports_volume: true`. Los comandos de volumen siguen intentándolo una vez por sesión y, tras un 403, avisan sin volver a pedir.
- Las prioridades de los elementos de la barra de estado van de 45.5 a 45.0. No deben coincidir con las de VS Code (problemas = 50, puertos = 40): un empate deja un elemento ajeno en medio de los botones.

### Búsqueda (etapa 3)

Comando "Spotify: Buscar canción": QuickPick con input que consulta `GET /search` (`type=track`, `limit=10`) con debounce. Al elegir un resultado se reproduce con `PUT /me/player/play`.

La canción se reproduce dentro de su álbum (`context_uri` del álbum y `offset.uri` de la canción), no como URI suelta. El usuario comprobó que con `uris: [canción]` la reproducción se detiene al terminar, y eligió que continúe con el álbum. Si Spotify rechaza el contexto con 400 o 404, `Player.playTrack()` cae a la URI suelta. Un sencillo de una sola pista se sigue deteniendo salvo que el usuario tenga Autoplay activado.

### Biblioteca (etapa 6)

- El usuario pidió las dos formas de acceso: árbol en la barra lateral (vista "Biblioteca", plegada por defecto para no quitarle sitio a la letra) y QuickPick ("Spotify: Elegir de mi biblioteca").
- Una canción de una playlist se reproduce dentro de esa playlist (`context_uri` + `offset.uri`), para que después sigan las demás.
- "Tus me gusta" no existe como contexto en la API: se envían por `uris` la canción elegida y las siguientes ya cargadas, hasta 100. Al acabar esa lista la reproducción se detiene.
- Una lista de `uris` con más de una canción va siempre con `offset: { position: 0 }`. El usuario vio el 2026-10-08 que, sin `offset`, al elegir una canción de Tus me gusta empezaba a sonar otra, sin ningún error. La causa es el modo aleatorio del reproductor, que sin `offset` arranca por cualquiera de la lista: con `offset` el usuario confirmó que suena la elegida, y cree que tenía el aleatorio activado. En las playlists no pasaba, y ahí siempre se envía `offset.uri`.
- Spotify solo deja listar las canciones de playlists propias o colaborativas; para las demás `GET /playlists/{id}/items` responde 403. Esas playlists se muestran sin desplegar y el clic las reproduce enteras.
- Se descartan los pódcast y los archivos locales, que no se reproducen como una canción normal.
- El QuickPick carga las páginas una tras otra mientras está abierto, hasta 2000 canciones, y filtra sobre lo cargado.
- Una sesión anterior a la versión 0.2 no tiene los scopes de biblioteca. `AuthManager` vuelve a disparar `onDidChangeSession` cuando un nuevo login cambia los permisos, y al renovar el token conserva el `scope` guardado si la respuesta no lo repite.

### Letra sincronizada (etapa 4)

- **Fuente:** LRCLIB. Primero `/api/get`; si falla, `/api/search`. Se usa `syncedLyrics`; si solo hay `plainLyrics`, se muestra sin sincronizar. Si LRCLIB no tiene la canción, mensaje claro. Caché en memoria por track ID. Un 5xx de LRCLIB se trata como "no encontrada, pero dudoso": mensaje propio, sin reintentos y con caché de solo 5 minutos. Solo un fallo de red o un timeout se reintenta, cada 30 s mientras siga sonando esa canción.
- **Sincronización:** polling a `GET /me/player` cada ~3 s para leer `progress_ms`. Entre lecturas se interpola con un temporizador de ~200 ms y el desfase se corrige en cada lectura. Hay que detectar cambio de canción, pausa y seek.
- **Ahorro de peticiones:** con la ventana sin foco o sin reproducción activa el polling baja a ~30 s. La letra sigue por interpolación local y al recuperar el foco se hace una lectura inmediata.
- **Vista:** `WebviewView` en un contenedor propio de la Activity Bar, con la línea actual resaltada y auto-scroll suave. La línea actual también va en la barra de estado, activable con `spotifyLocal.showLyricsInStatusBar`.
- **Offset:** posición efectiva = `progress_ms + spotifyLocal.lyricsOffsetMs`. Un valor positivo adelanta la letra y uno negativo la retrasa, que es lo que compensa la latencia Bluetooth. Dos comandos lo suben y bajan en pasos de 250 ms.

## APIs externas: lo verificado

Verificado el 2026-10-08 contra la guía de migración y el changelog de febrero de 2026 de Spotify, y con llamadas reales a LRCLIB.

### Spotify Web API en Development Mode

- El dueño de la app debe tener Premium y cada app admite 5 usuarios como máximo.
- Siguen disponibles todos los endpoints de `/me/player` (estado, dispositivos, transferencia, play, pause, next, previous, volume, seek, queue), además de `GET /search` y `GET /me`.
- `GET /search`: `limit` máximo 10 y por defecto 5.
- Biblioteca: `GET /me/playlists`, `GET /playlists/{id}/items` y `GET /me/tracks` siguen disponibles, con `limit` máximo 50. En las playlists el recuento está en `items.total` (`tracks` quedó obsoleto) y cada elemento trae la canción en `item` (`track` quedó obsoleto); en `GET /me/tracks` sigue viniendo en `track`.
- Campos eliminados que no se deben leer. Track: `available_markets`, `external_ids`, `linked_from`, `popularity`. Album: `album_group`, `available_markets`, `external_ids`, `label`, `popularity`. Artist: `followers`, `popularity`. `GET /me`: `country`, `email`, `explicit_content`, `followers`, `product`; sin `product` no se puede comprobar Premium por API.
- Endpoints eliminados en febrero de 2026: los GET por lotes (`/tracks`, `/albums`, `/artists`, `/episodes`, `/shows`, `/audiobooks`, `/chapters`), `/browse/new-releases`, `/browse/categories`, `/artists/{id}/top-tracks`, `/users/{id}`, `/users/{id}/playlists` y `/markets`. Los de playlists pasaron de `/tracks` a `/items` y los de biblioteca se unificaron en `/me/library`.
- Eliminados desde noviembre de 2024: recommendations, audio-features, audio-analysis, related-artists y featured-playlists.
- Tokens: el access token dura 3600 s. El refresh token dura 6 meses desde la autorización y renovar no extiende ese plazo; cuando vence, el endpoint de token responde `invalid_grant` y hay que volver a iniciar sesión. La respuesta de renovación puede no traer `refresh_token`, y entonces se conserva el anterior.

### LRCLIB

- `GET https://lrclib.net/api/get` con `track_name`, `artist_name`, `album_name` y `duration` en segundos. Devuelve un objeto si hay coincidencia exacta. Con los metadatos de Spotify tal cual, incluidos títulos como "Bohemian Rhapsody - Remastered 2011", respondió 200 en las tres canciones reales probadas.
- `GET https://lrclib.net/api/search` con `track_name` y `artist_name`. Devuelve un array de hasta 20 resultados, o `[]` si el título existe pero el artista no coincide.
- Campos útiles: `id`, `trackName`, `artistName`, `albumName`, `duration` (segundos, decimal), `instrumental`, `plainLyrics`, `syncedLyrics`.
- **Para una canción que no conoce, LRCLIB no responde de forma consistente:** unas veces 404 y muchas otras 503 con cuerpo vacío en medio segundo, tanto en `/get` como en `/search`. Un 503 no significa que el servicio esté caído, y por eso no se reintenta.
- Enviar un `User-Agent` que identifique la extensión. Solo ASCII: `fetch` rechaza cabeceras con tildes.
