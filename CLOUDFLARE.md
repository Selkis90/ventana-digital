# Ventana Digital 3.0: video gratis todo el mes con Cloudflare Realtime

## Qué cambió y por qué

La versión 2.x usaba **LiveKit Cloud**. Su plan gratis da 5.000 minutos al mes. Con una cámara abierta de 8 a 5 se acaba a mitad de mes: en septiembre se gastaron 3.480 minutos, y solo del 1 al 12 de octubre ya iban 3.071.

La 3.0 usa **Cloudflare Realtime (Serverless SFU)**:

| | LiveKit (antes) | Cloudflare Realtime (ahora) |
|---|---|---|
| Gratis al mes | 5.000 minutos | **1.000 GB**, sin límite de minutos |
| Qué se cobra | minutos conectados | solo los datos que Cloudflare envía a los navegadores |
| Tarjeta | – | se registra, pero el cobro es $0 hasta 1.000 GB |
| Si se pasa | – | US$0,05 por GB extra |

**Render se queda igual.** El video no pasa por Render: va directo entre los navegadores y Cloudflare. Render solo mueve mensajes pequeños por WebSocket (quién entró, quién salió).

### ¿Alcanza el cupo gratis?

Con `CALIDAD=normal` (720p a 1 Mbps máx.), cada persona que **mira** a otra gasta unos **0,46 GB por hora**:

| Uso | GB al mes | ¿Gratis? |
|---|---|---|
| 2 equipos, lun–vie 8 a 5 | ≈ 180 GB | ✅ sobra |
| 2 equipos, prendidos 24/7 | ≈ 685 GB | ✅ |
| 3 equipos, lun–vie 8 a 5 | ≈ 550 GB | ✅ |
| 3 equipos, prendidos 24/7 | ≈ 2.000 GB | ❌ en ese caso usa `HORARIO` |

Render free: mientras haya alguien conectado el servicio no se duerme. Un mes completo tiene 744 h y el plan gratis da 750 h, así que alcanza aunque esté prendido siempre, siempre que sea el único servicio en tu cuenta de Render.

---

## Pasos para ponerlo en marcha

### 1. Crear la app en Cloudflare (5 minutos)
1. Entra a <https://dash.cloudflare.com> (crea la cuenta si no la tienes; es gratis).
2. En el menú, ve a **Realtime** → **Serverless SFU** → **Create**. Ponle el nombre `ventana-digital`.
   - ⚠️ **No** elijas *RealtimeKit*: ese cobra por minuto y no tiene plan gratis.
3. Copia el **App ID** y el **App Secret / API Token**.

### 2. (Recomendado) Crear la llave TURN
Sirve para redes de empresa que bloquean videollamadas. No cuesta más: comparte el cupo de 1.000 GB.
1. Ve a **Realtime** → **TURN Server** → **Create**.
2. Copia el **Turn Token ID** y el **API Token**.

### 3. Variables en Render
Ve a tu servicio en Render → **Environment**:

| Acción | Variable | Valor |
|---|---|---|
| ➕ agregar | `CF_APP_ID` | el App ID del paso 1 |
| ➕ agregar | `CF_APP_TOKEN` | el token del paso 1 |
| ➕ agregar (opcional) | `CF_TURN_KEY_ID` | el Turn Token ID del paso 2 |
| ➕ agregar (opcional) | `CF_TURN_KEY_TOKEN` | el API Token del paso 2 |
| ➕ agregar (opcional) | `HORARIO` | por ejemplo `lun-vie 07:30-17:30` |
| 🗑️ borrar | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | ya no se usan |
| 🗑️ borrar | `TELEGRAM_*`, `TWILIO_*`, `OWNER_PHONE`, `TOKEN_TTL` | ya no se usan |

### 4. Subir el código
```bash
git add -A
git commit -m "Ventana Digital 3.0: video con Cloudflare Realtime (gratis)"
git push
```
Render despliega solo.

### 5. Comprobar
Abre `https://TU-APP.onrender.com/health`. Debe aparecer algo así:
```json
{ "status": "ok", "version": "3.0.0", "video": "cloudflare", "turn": true, ... }
```
Después abre la página en dos equipos (o en el celular y el PC) y prueba video, audio, apagar y prender la cámara, y compartir pantalla.

---

## Opciones

### En la URL (por equipo)
| Parámetro | Qué hace |
|---|---|
| `?nombre=Recepcion` | nombre que ven los demás |
| `&mic=0` / `&cam=0` | entrar con el micrófono o la cámara apagados |
| `&calidad=baja` | gastar menos datos en ese equipo (`alta`, `normal`, `baja`) |

### En Render (para todos)
| Variable | Por defecto | Qué hace |
|---|---|---|
| `CALIDAD` | `normal` | `alta` ≈ 0,7 GB/h · `normal` ≈ 0,46 GB/h · `baja` ≈ 0,2 GB/h |
| `MAX_PARTICIPANTES` | `6` | protege el cupo si alguien comparte el enlace de más |
| `HORARIO` | vacío (24 h) | fuera del horario los equipos se desconectan, liberan la cámara y vuelven a entrar solos a la hora de apertura |
| `ZONA_HORARIA` | `America/Bogota` | zona para `HORARIO` |

## Ver el consumo
- **Exacto:** panel de Cloudflare → Realtime → tu app → Analytics.
- **Estimado:** `/health` → `consumo`, o el botón ⓘ (Diagnóstico) dentro de la llamada. Este dato se reinicia si Render reinicia el servidor.

---

## Otras mejoras de la 3.0
- Ya no se carga ninguna librería desde un CDN: el motor de video (`cliente/js/motor.js`) es propio. La página carga más rápido y no se rompe si un CDN se cae.
- Al apagar la cámara se libera de verdad (se apaga la luz) y no se gastan datos.
- Reconexión automática si se cae el internet, si Render se reinicia o si cambia la red.
- Aviso de "sala llena" y límite de participantes.
- El WebSocket solo acepta conexiones desde tu propia página.
- Se quitó `servidor/ingreso.js` (el acceso por código de SMS/Telegram, que ya no se usaba) y la dependencia `livekit-server-sdk`.

## Diferencias frente a LiveKit
- Al compartir pantalla se envía solo la imagen, sin el audio del PC.
- La calidad de cada video es fija (según `CALIDAD`), sin capas automáticas. El navegador sí baja la calidad solo cuando la conexión está mala.

## Probar en local
```bash
cd servidor
cp .env.example .env   # y llena CF_APP_ID y CF_APP_TOKEN
npm install
npm start              # http://localhost:3000
```
