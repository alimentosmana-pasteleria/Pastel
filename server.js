const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));

// En vez de usar SMTP (Brevo), reenviamos el correo usando la API de EmailJS.
// Así Render no necesita variables SMTP.
const EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
const EMAILJS_SERVICE_ID = "service_o5hr0t7";
const EMAILJS_TEMPLATE_ID = "template_oqfm2bj";
const EMAILJS_PUBLIC_KEY = "5no_XBD8dVSyjFqui";

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

async function handleSendOrder(req, res) {
  try {
    const { toEmail, replyTo, subject, text, pdfFilename, pdfBase64 } = req.body || {};

    if (!toEmail || !subject || !text || !pdfFilename || !pdfBase64) {
      return res.status(400).json({ error: "Faltan datos obligatorios para enviar el pedido" });
    }

    // Nota: body.template_params usa nombres que tu template de EmailJS debe aceptar.
    const emailjsResp = await fetch(EMAILJS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: toEmail,
          reply_to: replyTo || toEmail,
          name: "Pedido Web",
          title: subject,
          message: text,
          pdf_filename: pdfFilename,
          pdf_base64: pdfBase64,
          attachments: [{ name: pdfFilename, data: pdfBase64 }],
        },
      }),
    });

    const raw = await emailjsResp.text();
    if (!emailjsResp.ok) {
      return res.status(502).json({ error: raw || "EmailJS rechazó el envío" });
    }

    res.status(200).json({ ok: true, provider: "emailjs", response: raw || "ok" });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Error interno al enviar pedido" });
  }
}

// Ruta nueva (nuestra)
app.post("/api/send-order", handleSendOrder);
// Ruta vieja (por si tu index.html en GitHub aún apunta a Netlify)
app.post("/.netlify/functions/send-order", handleSendOrder);

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
