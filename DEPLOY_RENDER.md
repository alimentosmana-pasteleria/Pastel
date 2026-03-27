# 🚀 Deploy en Render — Guía paso a paso

## 1. Prepara tu repositorio en GitHub

```bash
git init
git add .
git commit -m "Pasteleria: sistema de pedidos con PDF y correo"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/pasteleria-pedidos.git
git push -u origin main
```

## 2. Crea el servicio en Render

1. Ve a **https://render.com** y crea una cuenta (gratis)
2. Click en **"New +"** → **"Web Service"**
3. Conecta tu repositorio de GitHub
4. Configura:
   - **Name:** pasteleria-pedidos
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

## 3. Variables de entorno en Render

En tu servicio → **"Environment"** → agrega **solo estas tres** (nada de SMTP_HOST ni otras):

| Variable      | Valor                          |
|---------------|-------------------------------|
| EMAIL_USER    | tu correo Gmail que envía       |
| EMAIL_PASS    | contraseña de aplicación (16 letras) |
| EMAIL_CHEF    | correo donde recibes los pedidos (puede ser el mismo) |

### ¿Cómo obtener la contraseña de aplicación de Gmail?
1. Ve a tu cuenta Google → Seguridad
2. Activa **Verificación en 2 pasos** (si no la tienes)
3. Busca **"Contraseñas de aplicaciones"**
4. Genera una para "Correo / Otro dispositivo"
5. Copia las 16 letras → esa es tu EMAIL_PASS

## 4. Listo 🎉

Tu URL será: `https://pasteleria-pedidos.onrender.com`

Comparte ese link o genera un QR con:
- https://qrcode-monkey.com
- https://www.qr-code-generator.com

## Estructura del proyecto

```
pasteleria-pedidos/
├── public/
│   └── index.html      ← formulario del cliente
├── server.js           ← backend Node.js
├── package.json
├── .gitignore
├── .env.example        ← referencia de variables
└── DEPLOY_RENDER.md    ← esta guía
```

## Cómo funciona el flujo

1. Cliente escanea QR → llega a la página
2. Llena el formulario (con imagen opcional)
3. Presiona "Enviar pedido"
4. El servidor:
   a. Recibe todos los datos + imagen
   b. Genera un PDF con PDFKit (incluye imagen)
   c. Envía email al CHEF con PDF + imagen adjuntos
   d. Envía email de confirmación al CLIENTE con su PDF
5. La página muestra pantalla de éxito
