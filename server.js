const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

/**
 * Si Render no inyecta variables, puedes subir un archivo `.env` en la raíz
 * (copia `.env.example` → `.env` y rellena). Solo rellena claves vacías en process.env.
 */
function loadEnvFile() {
  const fp = path.join(__dirname, ".env");
  if (!fs.existsSync(fp)) return;
  const text = fs.readFileSync(fp, "utf8");
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    const cur = process.env[key];
    if (cur == null || String(cur).trim() === "") {
      process.env[key] = val;
    }
  }
}
loadEnvFile();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));

/**
 * No pongas claves reales aquí si subes el repo a GitHub (es público o se escanea).
 * Usa solo Render → Environment (SMTP_USER, SMTP_PASS, FROM_EMAIL) o un archivo `.env` local
 * que NO se sube (está en .gitignore).
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
  if (!u) u = String(SMTP_FALLBACK_USER || "").trim();
  if (!u) u = readSmtpJsonFile().user;
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
  if (!p) p = String(SMTP_FALLBACK_PASS || "").trim();
  if (!p) p = readSmtpJsonFile().pass;
  return p;
}

function getFromEmail() {
  let f = firstEnv(["FROM_EMAIL", "MAIL_FROM", "SMTP_FROM"]);
  if (!f) f = String(SMTP_FALLBACK_FROM || "").trim();
  if (!f) f = readSmtpJsonFile().from;
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
      "Error SMTP: falta usuario o clave. Abre server.js y rellena SMTP_FALLBACK_USER y SMTP_FALLBACK_PASS (líneas de arriba), guarda, sube a GitHub y despliega."
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
  const envFileOk = fs.existsSync(path.join(__dirname, ".env"));
  res.status(200).json({
    ok: true,
    smtpConfigured: hasUser && hasPass,
    hasSmtpUser: hasUser,
    hasSmtpPass: hasPass,
    hasSmtpJsonFile: fileOk,
    hasEnvFile: envFileOk,
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
