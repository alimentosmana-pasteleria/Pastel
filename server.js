const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));

/** Render/Brevo a veces nombran distinto las variables; probamos alias comunes. */
function firstEnv(keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function getSmtpUser() {
  return firstEnv(["SMTP_USER", "BREVO_SMTP_LOGIN", "SMTP_LOGIN", "MAIL_USER", "EMAIL_USER"]);
}

function getSmtpPass() {
  return firstEnv([
    "SMTP_PASS",
    "SMTP_PASSWORD",
    "BREVO_SMTP_KEY",
    "BREVO_SMTP_PASSWORD",
    "SMTP_KEY",
  ]);
}

function getFromEmail() {
  return firstEnv(["FROM_EMAIL", "MAIL_FROM", "SMTP_FROM"]) || getSmtpUser();
}

function createTransporter() {
  const user = getSmtpUser();
  const pass = getSmtpPass();

  if (!user || !pass) {
    throw new Error(
      "Faltan credenciales SMTP. En Render define al menos: SMTP_USER y SMTP_PASS " +
        "(o alias: BREVO_SMTP_LOGIN + BREVO_SMTP_KEY / SMTP_PASSWORD)."
    );
  }

  return nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
    auth: { user, pass },
  });
}

app.get("/health", (_req, res) => {
  const user = getSmtpUser();
  const pass = getSmtpPass();
  const hasUser = Boolean(user);
  const hasPass = Boolean(pass);
  res.status(200).json({
    ok: true,
    smtpConfigured: hasUser && hasPass,
    hasSmtpUser: hasUser,
    hasSmtpPass: hasPass,
  });
});

async function handleSendOrder(req, res) {
  try {
    const { toEmail, replyTo, subject, text, pdfFilename, pdfBase64 } = req.body || {};

    if (!toEmail || !subject || !text || !pdfFilename || !pdfBase64) {
      return res.status(400).json({ error: "Faltan datos obligatorios para enviar el pedido" });
    }

    const transporter = createTransporter();
    const fromEmail = getFromEmail();

    await transporter.sendMail({
      from: fromEmail,
      to: toEmail,
      replyTo: replyTo || fromEmail,
      subject,
      text,
      attachments: [
        {
          filename: pdfFilename,
          content: pdfBase64,
          encoding: "base64",
          contentType: "application/pdf",
        },
      ],
    });

    res.status(200).json({ ok: true, provider: "smtp" });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Error interno al enviar pedido" });
  }
}

// Ruta nueva (nuestra)
app.post("/api/send-order", handleSendOrder);

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
