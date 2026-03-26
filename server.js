const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));

/**
 * Último recurso si Render NO inyecta variables de entorno:
 * rellena aquí usuario y clave SMTP de Brevo (mismo valor que en Brevo → SMTP).
 * Déjalos vacíos "" si usas solo Render Environment o smtp.json
 */
const SMTP_FALLBACK_USER = "";
const SMTP_FALLBACK_PASS = "";
const SMTP_FALLBACK_FROM = "";

/** Render/Brevo a veces nombran distinto las variables; probamos alias comunes. */
function firstEnv(keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function readSmtpJsonFile() {
  try {
    const fp = path.join(__dirname, "smtp.json");
    if (!fs.existsSync(fp)) return { user: "", pass: "", from: "", host: "", port: "" };
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    return {
      user: String(j.user || j.login || "").trim(),
      pass: String(j.pass || j.password || j.key || "").trim(),
      from: String(j.from || "").trim(),
      host: String(j.host || "").trim(),
      port: String(j.port || "").trim(),
    };
  } catch (e) {
    console.error("smtp.json:", e.message);
    return { user: "", pass: "", from: "", host: "", port: "" };
  }
}

function getSmtpUser() {
  let u = firstEnv(["SMTP_USER", "BREVO_SMTP_LOGIN", "SMTP_LOGIN", "MAIL_USER", "EMAIL_USER"]);
  if (!u) u = readSmtpJsonFile().user;
  if (!u) u = String(SMTP_FALLBACK_USER || "").trim();
  return u;
}

function getSmtpPass() {
  let p = firstEnv([
    "SMTP_PASS",
    "SMTP_PASSWORD",
    "BREVO_SMTP_KEY",
    "BREVO_SMTP_PASSWORD",
    "SMTP_KEY",
  ]);
  if (!p) p = readSmtpJsonFile().pass;
  if (!p) p = String(SMTP_FALLBACK_PASS || "").trim();
  return p;
}

function getFromEmail() {
  let f = firstEnv(["FROM_EMAIL", "MAIL_FROM", "SMTP_FROM"]);
  if (!f) f = readSmtpJsonFile().from;
  if (!f) f = String(SMTP_FALLBACK_FROM || "").trim();
  return f || getSmtpUser();
}

function getSmtpHost() {
  let h = firstEnv(["SMTP_HOST"]);
  if (!h) h = readSmtpJsonFile().host;
  return h || "smtp-relay.brevo.com";
}

function getSmtpPort() {
  let p = firstEnv(["SMTP_PORT"]);
  if (!p) p = readSmtpJsonFile().port;
  const n = parseInt(String(p || "587"), 10);
  return Number.isFinite(n) && n > 0 ? n : 587;
}

function createTransporter() {
  const user = getSmtpUser();
  const pass = getSmtpPass();
  const host = getSmtpHost();
  const port = getSmtpPort();

  if (!user || !pass) {
    throw new Error(
      "Faltan credenciales SMTP. En Render: SMTP_USER y SMTP_PASS (y opcional SMTP_HOST, SMTP_PORT, FROM_EMAIL). " +
        "O usa smtp.json / SMTP_FALLBACK_* en server.js."
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

app.get("/health", (_req, res) => {
  const user = getSmtpUser();
  const pass = getSmtpPass();
  const hasUser = Boolean(user);
  const hasPass = Boolean(pass);
  const fileOk = fs.existsSync(path.join(__dirname, "smtp.json"));
  res.status(200).json({
    ok: true,
    smtpConfigured: hasUser && hasPass,
    hasSmtpUser: hasUser,
    hasSmtpPass: hasPass,
    hasSmtpJsonFile: fileOk,
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
