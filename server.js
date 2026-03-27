'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  Maná Alimentos — Servidor de Pedidos
//  Versión: segura y robusta
//  Protecciones: Helmet, Rate Limit, Validación, Sanitización XSS,
//                Verificación MIME real, Timeout en PDF, Retry en email
// ═══════════════════════════════════════════════════════════════════════════════

const express      = require('express');
const multer       = require('multer');
const nodemailer   = require('nodemailer');
const PDFDocument  = require('pdfkit');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Verificar variables de entorno al arrancar ───────────────────────────────
const REQUIRED_ENV = ['EMAIL_USER', 'EMAIL_PASS'];
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ FATAL: Variable de entorno ${key} no definida. El servidor no puede arrancar.`);
    process.exit(1);
  }
});
const EMAIL_CHEF = process.env.EMAIL_CHEF || process.env.EMAIL_USER;

// ─── Helmet: cabeceras HTTP de seguridad ─────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // necesario para el JS inline del form
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false,
}));

// Ocultar fingerprint del servidor
app.disable('x-powered-by');

// ─── Rate Limiting: máx 10 pedidos por IP cada 15 minutos ────────────────────
const pedidoLimiter = rateLimit({
  windowMs:  15 * 60 * 1000,  // 15 minutos
  max:       10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Demasiadas solicitudes. Intenta en unos minutos.' },
  skip: (req) => req.method !== 'POST',   // solo limita POST
});

// ─── Multer: imagen en memoria, validación estricta ──────────────────────────
const ALLOWED_MIME  = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;  // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Tipo de archivo no permitido. Solo JPG, PNG, WEBP.'));
    }
  }
});

// ─── Archivos estáticos ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  etag:         true,
  maxAge:       '1d',
  setHeaders:   (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// ─── Sanitizador XSS simple (sin dependencias extra) ─────────────────────────
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim()
    .slice(0, 500);  // límite máximo por campo
}

// ─── Validador de campos del formulario ──────────────────────────────────────
const CAMPOS_REQUERIDOS = ['nombre', 'telefono', 'correo', 'direccion', 'fecha', 'hora', 'tamano', 'saborBizcocho', 'relleno', 'cobertura', 'tipoDiseno'];
const TAMANOS_VALIDOS   = ['Pequeño (8-10 piezas)', 'Mediano (12-15 piezas)', 'Grande (18-20 piezas)', 'Extra Grande (25+ piezas)'];
const DISENOS_VALIDOS   = ['Chef decide', 'Personalizado'];
const SABORES_VALIDOS   = ['Vainilla', 'Chocolate', 'Red Velvet', 'Limón', 'Zanahoria', 'Mármol (vainilla + chocolate)', 'Otro'];
const RELLENOS_VALIDOS  = ['Crema pastelera', 'Buttercream de vainilla', 'Ganache de chocolate', 'Mermelada de fresa', 'Dulce de leche', 'Nutella', 'Otro'];
const COBERTURAS_VALIDAS= ['Buttercream liso', 'Fondant', 'Ganache', 'Semi naked cake', 'Crema chantilly', 'Otro'];
const COLORES_VALIDOS   = ['Blanco', 'Rosa', 'Dorado', 'Negro', 'Azul', 'Verde', 'Morado', 'Otro'];
const REGEX_EMAIL       = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REGEX_FECHA       = /^\d{4}-\d{2}-\d{2}$/;
const REGEX_HORA        = /^\d{2}:\d{2}$/;
const REGEX_TEL         = /^[\d\s\+\-\(\)]{6,20}$/;

function validarPedido(body) {
  const errores = [];

  // Campos requeridos
  for (const campo of CAMPOS_REQUERIDOS) {
    if (!body[campo] || String(body[campo]).trim() === '') {
      errores.push(`Campo requerido: ${campo}`);
    }
  }
  if (errores.length) return errores;

  // Formato email
  if (!REGEX_EMAIL.test(body.correo))    errores.push('Correo inválido');
  // Formato fecha
  if (!REGEX_FECHA.test(body.fecha))     errores.push('Fecha inválida');
  // Fecha no en el pasado
  const fechaPedido = new Date(body.fecha + 'T00:00:00');
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  if (fechaPedido < hoy)                 errores.push('La fecha no puede ser en el pasado');
  // Formato hora
  if (!REGEX_HORA.test(body.hora))       errores.push('Hora inválida');
  // Teléfono
  if (!REGEX_TEL.test(body.telefono))    errores.push('Teléfono inválido');

  // Enumeraciones (previene inyección de valores inventados)
  if (!TAMANOS_VALIDOS.includes(body.tamano))           errores.push('Tamaño inválido');
  if (!DISENOS_VALIDOS.includes(body.tipoDiseno))       errores.push('Tipo de diseño inválido');
  if (!SABORES_VALIDOS.includes(body.saborBizcocho))    errores.push('Sabor de bizcocho inválido');
  if (!RELLENOS_VALIDOS.includes(body.relleno))         errores.push('Relleno inválido');
  if (!COBERTURAS_VALIDAS.includes(body.cobertura))     errores.push('Cobertura inválida');

  // Colores (array opcional)
  if (body.colores) {
    const colores = Array.isArray(body.colores) ? body.colores : [body.colores];
    const invalidos = colores.filter(c => !COLORES_VALIDOS.includes(c));
    if (invalidos.length) errores.push('Colores inválidos: ' + invalidos.join(', '));
  }

  return errores;
}

// ─── Verificación de magic bytes (firma real del archivo) ─────────────────────
function verificarMagicBytes(buffer, mimetype) {
  if (!buffer || buffer.length < 4) return false;
  const bytes = buffer.slice(0, 4);
  switch (mimetype) {
    case 'image/jpeg': return bytes[0] === 0xFF && bytes[1] === 0xD8;
    case 'image/png':  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
    case 'image/webp': return buffer.slice(0,4).toString('ascii') === 'RIFF' && buffer.slice(8,12).toString('ascii') === 'WEBP';
    case 'image/gif':  return bytes.slice(0,3).toString('ascii') === 'GIF';
    default: return false;
  }
}

// ─── Nodemailer con verificación de conexión al arrancar ─────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  pool: true,             // reutiliza conexiones
  maxConnections: 3,
  rateDelta: 1000,
  rateLimit: 5,
});

transporter.verify((err) => {
  if (err) {
    console.error('❌ Error de conexión SMTP:', err.message);
    console.error('   Verifica EMAIL_USER y EMAIL_PASS en las variables de entorno.');
  } else {
    console.log('✅ SMTP conectado correctamente. Listo para enviar correos.');
  }
});

// ─── Función de reintento para envío de correo ───────────────────────────────
async function enviarConReintento(opciones, intentos = 3, espera = 2000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const info = await transporter.sendMail(opciones);
      return info;
    } catch (err) {
      console.error(`   Intento ${i}/${intentos} fallido:`, err.message);
      if (i < intentos) await new Promise(r => setTimeout(r, espera * i));
      else throw err;
    }
  }
}

// ─── Logo cargado una sola vez en memoria ────────────────────────────────────
const LOGO_PATH = path.join(__dirname, 'public', 'logo.jpg');
let   LOGO_BUFFER = null;
try {
  if (fs.existsSync(LOGO_PATH)) {
    LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
    console.log('✅ Logo cargado en memoria.');
  }
} catch (e) {
  console.warn('⚠️ No se pudo cargar el logo:', e.message);
}

// ─── Generador de PDF ─────────────────────────────────────────────────────────
function generarPDF(data, imagenBuffer) {
  return new Promise((resolve, reject) => {

    // Timeout de seguridad: si el PDF tarda >15s, rechazar
    const timeout = setTimeout(() => reject(new Error('Timeout generando PDF')), 15000);

    const doc    = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data',  c  => chunks.push(c));
    doc.on('end',   () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
    doc.on('error', e  => { clearTimeout(timeout); reject(e); });

    const GOLD = '#c98a1a', GOLD2 = '#e6a020', MUTED = '#9a8060';
    const BG   = '#0f0d08', CARD  = '#161410', BORDER = '#2e2418';

    // Fondo
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);
    // Barra dorada
    doc.rect(0, 0, doc.page.width, 5).fill(GOLD);

    // Logo
    if (LOGO_BUFFER) {
      try {
        const lx = (doc.page.width - 70) / 2;
        doc.image(LOGO_BUFFER, lx, 20, { width: 70, height: 70 });
      } catch (_) {}
    }

    // Encabezado
    doc.y = 100;
    doc.font('Helvetica-Bold').fontSize(22).fillColor(GOLD2).text('Maná Alimentos', { align: 'center' });
    doc.font('Helvetica').fontSize(12).fillColor('#c8b898').text('Cotización de Pedido', { align: 'center' });
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text('Generado el ' + new Date().toLocaleString('es-MX', {
         weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
       }), { align: 'center' });

    // Número de folio único
    const folio = 'MANA-' + Date.now().toString(36).toUpperCase();
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD)
       .text('Folio: ' + folio, { align: 'center' });

    // Línea dorada
    doc.moveDown(0.7);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
       .strokeColor(GOLD).lineWidth(0.8).stroke();
    doc.moveDown(0.8);

    // Función sección con manejo de página
    function seccion(titulo, campos) {
      // Si queda poco espacio, saltar página
      if (doc.y > doc.page.height - 180) {
        doc.addPage();
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);
        doc.rect(0, 0, doc.page.width, 5).fill(GOLD);
        doc.moveDown(1);
      }
      const y0 = doc.y;
      doc.rect(45, y0 - 5, doc.page.width - 90, 22).fill(CARD);
      doc.rect(45, y0 - 5, 3, 22).fill(GOLD);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(GOLD2).text(titulo, 56, y0 + 4);
      doc.moveDown(1);

      campos.forEach(([label, valor]) => {
        if (!valor || String(valor).trim() === '' || valor === 'undefined') return;
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), 55, doc.y);
        doc.font('Helvetica').fontSize(10).fillColor('#e8dcc8').text(String(valor), 55, doc.y);
        doc.moveDown(0.35);
      });

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
         .strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.moveDown(0.7);
    }

    const coloresStr = Array.isArray(data.colores)
      ? data.colores.join(', ') : (data.colores || '—');

    seccion('INFORMACIÓN DEL CLIENTE', [
      ['Nombre',   data.nombre],
      ['Teléfono', data.telefono],
      ['Correo',   data.correo],
    ]);
    seccion('DATOS DE ENTREGA', [
      ['Dirección',     data.direccion],
      ['Fecha',         data.fecha],
      ['Hora',          data.hora],
      ['Notas entrega', data.notasEntrega || '—'],
    ]);
    seccion('ESPECIFICACIONES DEL PASTEL', [
      ['Tamaño',         data.tamano],
      ['Número de pisos',data.pisos],
      ['Sabor bizcocho', data.saborBizcocho],
      ['Relleno',        data.relleno],
      ['Cobertura',      data.cobertura],
    ]);
    seccion('DISEÑO', [
      ['Tipo de diseño',          data.tipoDiseno],
      ['Colores solicitados',     coloresStr],
      ['Estilo / preferencia',    data.estiloChef || '—'],
    ]);
    seccion('DEDICATORIA Y NOTAS', [
      ['Texto en el pastel', data.dedicatoria || '—'],
      ['Comentarios',        data.comentarios || '—'],
    ]);

    // Imagen de referencia en página aparte
    if (imagenBuffer) {
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);
      doc.rect(0, 0, doc.page.width, 5).fill(GOLD);
      doc.y = 50;
      doc.font('Helvetica-Bold').fontSize(13).fillColor(GOLD2)
         .text('Imagen de referencia del cliente', { align: 'center' });
      doc.moveDown(1);
      try {
        doc.image(imagenBuffer, {
          fit: [doc.page.width - 100, 390],
          align: 'center',
        });
      } catch (_) {
        doc.font('Helvetica').fontSize(10).fillColor(MUTED)
           .text('No se pudo renderizar la imagen de referencia.', { align: 'center' });
      }
    }

    // Pie de página en TODAS las páginas
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(7.5).fillColor('#3a2e1e')
         .text(
           `Maná Alimentos · Folio ${folio} · Cotización generada automáticamente`,
           50, doc.page.height - 32,
           { align: 'center', width: doc.page.width - 100 }
         );
    }

    doc.end();
  });
}

// ─── HTML base para correos ───────────────────────────────────────────────────
function buildTablaHTML(data) {
  const coloresStr = Array.isArray(data.colores)
    ? data.colores.join(', ') : (data.colores || '—');

  const filas = [
    ['Nombre',        data.nombre],
    ['Teléfono',      data.telefono],
    ['Correo',        data.correo],
    ['Dirección',     data.direccion],
    ['Fecha',         data.fecha],
    ['Hora',          data.hora],
    ['Tamaño',        data.tamano],
    ['Pisos',         data.pisos],
    ['Bizcocho',      data.saborBizcocho],
    ['Relleno',       data.relleno],
    ['Cobertura',     data.cobertura],
    ['Tipo diseño',   data.tipoDiseno],
    ['Colores',       coloresStr],
    ['Dedicatoria',   data.dedicatoria || '—'],
    ['Comentarios',   data.comentarios || '—'],
  ];

  return filas.map(([k, v]) => `
    <tr>
      <td style="padding:9px 14px;font-weight:700;color:#9a8060;font-size:11px;
                 text-transform:uppercase;width:34%;background:#111111;
                 border-bottom:1px solid #1e1a12">${k}</td>
      <td style="padding:9px 14px;color:#f0e8d8;font-size:13px;
                 background:#0f0d08;border-bottom:1px solid #1e1a12">${v}</td>
    </tr>`).join('');
}

// ─── Ruta POST /api/pedido ────────────────────────────────────────────────────
app.post('/api/pedido',
  pedidoLimiter,
  upload.single('imagen'),
  async (req, res) => {

    // 1. Validar cuerpo
    const errores = validarPedido(req.body);
    if (errores.length) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos: ' + errores.join('; ') });
    }

    // 2. Verificar magic bytes de la imagen (si se subió una)
    let imagenBuffer = null;
    if (req.file) {
      if (!verificarMagicBytes(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ ok: false, error: 'El archivo de imagen está corrupto o no es válido.' });
      }
      imagenBuffer = req.file.buffer;
    }

    // 3. Sanitizar todos los campos de texto
    const data = {};
    const camposTexto = ['nombre','telefono','correo','direccion','fecha','hora',
                         'notasEntrega','tamano','tipoDiseno','estiloChef',
                         'saborBizcocho','relleno','cobertura','pisos',
                         'dedicatoria','comentarios'];
    camposTexto.forEach(c => { data[c] = sanitize(req.body[c] || ''); });

    // Colores: array sanitizado
    if (req.body.colores) {
      const raw = Array.isArray(req.body.colores) ? req.body.colores : [req.body.colores];
      data.colores = raw.map(c => sanitize(c)).filter(c => COLORES_VALIDOS.includes(c));
    } else {
      data.colores = [];
    }

    // 4. Generar PDF
    let pdfBuffer;
    try {
      pdfBuffer = await generarPDF(data, imagenBuffer);
    } catch (pdfErr) {
      console.error('Error generando PDF:', pdfErr.message);
      return res.status(500).json({ ok: false, error: 'No se pudo generar el PDF. Intenta de nuevo.' });
    }

    const nombreArchivo = `cotizacion-${data.nombre.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.pdf`;
    const tablaHTML = buildTablaHTML(data);
    const estiloEmail = `font-family:sans-serif;max-width:620px;margin:auto;
      background:#0a0a0a;border-radius:14px;overflow:hidden;
      border:1px solid #2e2418;box-shadow:0 4px 24px rgba(0,0,0,0.4)`;

    // 5. Correo al chef/dueña (prioritario) — con reintento automático
    try {
      await enviarConReintento({
        from:    `"Maná Alimentos" <${process.env.EMAIL_USER}>`,
        to:      EMAIL_CHEF,
        subject: `🎂 Cotización nueva — ${data.nombre} | Entrega: ${data.fecha}`,
        html: `
          <div style="${estiloEmail}">
            <div style="background:linear-gradient(135deg,#c98a1a 0%,#a06c10 100%);
                        padding:30px;text-align:center">
              <p style="color:rgba(0,0,0,0.6);font-size:10px;letter-spacing:3px;
                        margin:0 0 6px;text-transform:uppercase">Maná Alimentos</p>
              <h1 style="color:#000;margin:0;font-size:22px;font-weight:800">
                Nueva Cotización de Pastelería
              </h1>
              <p style="color:rgba(0,0,0,0.65);margin:8px 0 0;font-size:13px">
                Recibida el ${new Date().toLocaleString('es-MX')}
              </p>
            </div>
            <div style="padding:28px">
              <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden">
                ${tablaHTML}
              </table>
              <div style="margin-top:24px;padding:14px;background:#161410;
                          border-left:3px solid #c98a1a;border-radius:4px">
                <p style="margin:0;color:#9a8060;font-size:12px">
                  📎 El PDF con todos los detalles y la imagen de referencia (si aplica)
                  está adjunto a este correo.
                </p>
              </div>
            </div>
          </div>`,
        attachments: [
          {
            filename:    nombreArchivo,
            content:     pdfBuffer,
            contentType: 'application/pdf',
          },
          ...(imagenBuffer ? [{
            filename:    req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'),
            content:     imagenBuffer,
            contentType: req.file.mimetype,
          }] : [])
        ]
      });
    } catch (emailErr) {
      // Si no se puede notificar al chef es un error crítico
      console.error('❌ CRÍTICO: No se pudo enviar correo al chef después de 3 intentos:', emailErr.message);
      return res.status(500).json({
        ok: false,
        error: 'Error al procesar el pedido. Por favor contáctanos directamente.'
      });
    }

    // 6. Correo de confirmación al cliente (no crítico — si falla, el pedido igual se registró)
    try {
      await enviarConReintento({
        from:    `"Maná Alimentos" <${process.env.EMAIL_USER}>`,
        to:      data.correo,
        subject: '¡Tu cotización fue recibida! — Maná Alimentos',
        html: `
          <div style="${estiloEmail}">
            <div style="background:linear-gradient(135deg,#c98a1a 0%,#a06c10 100%);
                        padding:30px;text-align:center">
              <p style="color:rgba(0,0,0,0.6);font-size:10px;letter-spacing:3px;
                        margin:0 0 6px;text-transform:uppercase">Maná Alimentos</p>
              <h1 style="color:#000;margin:0;font-size:22px">
                Hola, ${data.nombre} 👋
              </h1>
              <p style="color:rgba(0,0,0,0.65);margin:8px 0 0;font-size:13px">
                Tu cotización fue recibida con éxito ✓
              </p>
            </div>
            <div style="padding:28px;color:#f0e8d8">
              <p style="font-size:15px;line-height:1.8;margin-bottom:22px">
                Gracias por confiar en <strong style="color:#e6a020">Maná Alimentos</strong>.
                Hemos recibido todos los detalles de tu pedido y nos pondremos en contacto
                contigo a la brevedad para confirmar disponibilidad y darte el precio final.
              </p>
              <div style="background:#161410;border:1px solid #2e2418;
                          border-left:3px solid #c98a1a;border-radius:8px;
                          padding:18px;margin-bottom:22px">
                <p style="margin:0 0 10px;font-size:11px;color:#9a8060;
                           text-transform:uppercase;letter-spacing:.5px">
                  Resumen de tu cotización
                </p>
                <p style="margin:5px 0;font-size:14px">
                  <span style="color:#9a8060">Tamaño:</span>
                  <strong>${data.tamano}</strong>
                </p>
                <p style="margin:5px 0;font-size:14px">
                  <span style="color:#9a8060">Sabor:</span>
                  <strong>${data.saborBizcocho}</strong>
                </p>
                <p style="margin:5px 0;font-size:14px">
                  <span style="color:#9a8060">Fecha de entrega:</span>
                  <strong>${data.fecha} a las ${data.hora}</strong>
                </p>
              </div>
              <p style="color:#5a4a30;font-size:12px;text-align:center">
                Adjunto a este correo encontrarás el PDF con el detalle completo de tu cotización.
              </p>
            </div>
          </div>`,
        attachments: [
          {
            filename:    `mi-cotizacion-mana.pdf`,
            content:     pdfBuffer,
            contentType: 'application/pdf',
          }
        ]
      });
    } catch (clienteErr) {
      // No crítico — el pedido ya fue registrado y el chef ya recibió su correo
      console.warn('⚠️ No se pudo enviar confirmación al cliente:', clienteErr.message);
    }

    // 7. Respuesta exitosa
    return res.status(200).json({ ok: true });
  }
);

// ─── Manejo global de errores de Multer ──────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const mensajes = {
      LIMIT_FILE_SIZE:      'La imagen no puede superar 5 MB.',
      LIMIT_UNEXPECTED_FILE:'Tipo de archivo no permitido. Solo JPG, PNG, WEBP.',
    };
    return res.status(400).json({ ok: false, error: mensajes[err.code] || err.message });
  }
  console.error('Error no manejado:', err);
  return res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
});

// ─── Ruta 404 ─────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada.' }));

// ─── Arrancar ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎂 Maná Alimentos — servidor corriendo en puerto ${PORT}`);
  console.log(`   Email chef:   ${EMAIL_CHEF}`);
  console.log(`   Email remite: ${process.env.EMAIL_USER}\n`);
});
