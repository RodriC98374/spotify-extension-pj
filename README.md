# Spotify Local

Extensión personal de VS Code para controlar Spotify, buscar canciones y ver la letra sincronizada. No reproduce audio: maneja el dispositivo donde ya tienes Spotify abierto, por ejemplo el celular.

## Requisitos

- Cuenta de Spotify Premium.
- VS Code 1.140 o posterior.
- Una app propia en el [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).

## Configuración

1. En el Dashboard, crea una app y marca **Web API** como API a usar.
2. En **Settings** de la app, añade este Redirect URI, exactamente así: `http://127.0.0.1:8888/callback`
3. Copia el **Client ID**. El Client Secret no se usa.
4. Instala la extensión: vista de Extensiones → menú `…` → **Install from VSIX…** y elige el archivo `spotify-local-<versión>.vsix`.
5. Abre los ajustes (`Ctrl+,`), busca `spotifyLocal` y pega el Client ID en **Client Id**.
6. `Ctrl+Shift+P` → **Spotify: Iniciar sesión** y autoriza en el navegador.

El puerto 8888 debe estar libre mientras inicias sesión.

Si actualizas desde una versión anterior a la 0.2, vuelve a iniciar sesión una vez: la biblioteca necesita permisos de lectura que la sesión antigua no tiene.

## Uso

La barra de estado muestra los botones de anterior, play/pausa y siguiente, el del modo aleatorio (flechas cruzadas si está activado, lista numerada si se reproduce en orden), la canción actual y la línea de la letra que está sonando. El icono de la nota musical en la barra de actividad abre dos vistas: **Letra**, con la letra completa, y **Biblioteca**, con Tus me gusta y tus playlists. En la biblioteca, despliega una lista y haz clic en una canción para reproducirla.

Todos los comandos están en la paleta (`Ctrl+Shift+P`) con el prefijo **Spotify:**

| Comando | Qué hace |
| --- | --- |
| Iniciar sesión / Cerrar sesión | Conecta o desconecta tu cuenta. |
| Reproducir / Pausar, Siguiente canción, Canción anterior | Controlan la reproducción. |
| Activar o desactivar el modo aleatorio | Cambia entre reproducción aleatoria y en orden. |
| Buscar canción | Busca por título o artista y reproduce la elegida dentro de su álbum. |
| Elegir de mi biblioteca | Elige Tus me gusta o una playlist y luego una canción, escribiendo para filtrar. |
| Mostrar biblioteca, Actualizar biblioteca | Abre la vista Biblioteca o vuelve a cargarla desde Spotify. |
| Transferir reproducción a un dispositivo | Lleva la música a otro de tus dispositivos. |
| Ajustar volumen, Subir volumen, Bajar volumen | Solo en dispositivos que lo permiten. |
| Mostrar letra | Abre la vista de la letra. |
| Subir / Bajar offset de la letra | Adelanta o retrasa la letra 250 ms. |
| Activar o desactivar la letra en la barra de estado | Muestra u oculta la línea actual. |

## Ajustes

| Ajuste | Para qué sirve |
| --- | --- |
| `spotifyLocal.clientId` | Client ID de tu app de Spotify. |
| `spotifyLocal.lyricsOffsetMs` | Desfase de la letra en milisegundos. Usa un valor negativo si la letra va adelantada, que es lo habitual con audífonos Bluetooth. |
| `spotifyLocal.showLyricsInStatusBar` | Muestra la línea actual de la letra en la barra de estado. |

## Limitaciones

- **Volumen:** muchos celulares no permiten cambiarlo desde la API de Spotify. En ese caso el botón de volumen no aparece.
- **Dispositivos:** Spotify solo lista un dispositivo si su app está abierta. Recién abierta puede no aparecer hasta que reproduce algo. Si un dispositivo deja de recibir órdenes (Spotify responde «Not found»), la extensión intenta reactivarlo y, si no lo consigue, pide abrir Spotify en él.
- **Playlists de otros:** Spotify solo deja ver las canciones de las playlists propias o colaborativas. Las demás aparecen en la biblioteca, pero solo se pueden reproducir enteras.
- **Tus me gusta:** al elegir una canción se envían esa y las 99 siguientes; después la reproducción se detiene.
- **Letras:** vienen de [LRCLIB](https://lrclib.net). No todas las canciones tienen letra, y algunas solo la tienen sin sincronizar.
- **Sesión:** Spotify obliga a iniciar sesión de nuevo cada 6 meses.
- **VS Code en segundo plano:** la letra sigue avanzando, pero un salto o un cambio manual de canción puede tardar hasta 30 segundos en reflejarse.

## Desarrollo

Requiere Node 22 o posterior.

```
npm install
npm run vsix
```

`npm run vsix` genera el `.vsix`. Para probar sin instalar, abre la carpeta en VS Code y pulsa `F5`.
