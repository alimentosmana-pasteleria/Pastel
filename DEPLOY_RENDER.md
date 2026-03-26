# Publicar en Render (paso a paso)

Esta guía y el `server.js` actual usan **las mismas variables**: lo que pongas en Render es lo que lee el servidor.

## 1) Subir proyecto a GitHub

1. Crea un repositorio (o usa el que ya tienes).
2. Sube: `index.html`, `server.js`, `package.json`, `package-lock.json`.

## 2) Brevo (correo SMTP)

1. Cuenta en Brevo: <https://www.brevo.com/>
2. Ve a **SMTP & API** y crea credenciales SMTP.
3. Anota estos datos (son los que vas a copiar a Render):

   - `SMTP_HOST` → normalmente `smtp-relay.brevo.com`
   - `SMTP_PORT` → `587`
   - `SMTP_USER`
   - `SMTP_PASS`
4. Define un correo remitente válido para **`FROM_EMAIL`** (verificado en Brevo).

## 3) Crear servicio en Render

1. Entra a <https://render.com/>
2. **New +** → **Web Service**
3. Conecta tu repositorio de GitHub.
4. Configura:

   - **Runtime**: Node  
   - **Build Command**: `npm install`  
   - **Start Command**: `npm start**

## 4) Variables de entorno en Render

En **Environment Variables** agrega (Key exacto, Value sin comillas):

| Key | Value (ejemplo Brevo) |
|-----|------------------------|
| `SMTP_HOST` | `smtp-relay.brevo.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | Tu login SMTP de Brevo |
| `SMTP_PASS` | Tu clave SMTP de Brevo |
| `FROM_EMAIL` | Tu correo remitente verificado |

Si no pones `SMTP_HOST` / `SMTP_PORT`, el servidor usa por defecto `smtp-relay.brevo.com` y `587`.

**Alternativa** (si Render fallara con las variables): archivo `smtp.json` en la raíz (ver `smtp.example.json`) o rellena `SMTP_FALLBACK_*` al inicio de `server.js`.

## 5) Deploy

1. **Create Web Service** (o guarda cambios).
2. Espera el deploy.
3. Abre la URL de Render.

## 6) Probar

1. Llena el formulario.
2. Pulsa **Concretar Pedido**.
3. Debe llegarte el correo con el PDF adjunto.

El envío va por `POST /api/send-order` (SMTP con Nodemailer).
