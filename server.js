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

// Permite que el formulario llame al API desde otro origen si CONFIG.apiBaseUrl apunta a este servidor.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));

/**
 * Render: preferible SMTP_USER + SMTP_PASS en Environment.
 * Local / sin env: LOGIN = solo tu usuario SMTP Brevo (…@smtp-brevo.com); PASS = solo xsmtpsib-…
 * No pongas la clave xsmtpsib en LOGIN (si las dos constantes son la clave, falla hasta corregir).
 */
const SMTP_FALLBACK_LOGIN = "";
const SMTP_FALLBACK_PASS = "";
/** @deprecated usar SMTP_FALLBACK_LOGIN + SMTP_FALLBACK_PASS; si rellenas esto, debe ser el login, no la clave */
const SMTP_FALLBACK_USER = "";
const SMTP_FALLBACK_FROM = "contacto.alimentosmana@gmail.com";

function looksLikeBrevoSecret(s) {
  return /xsmtpsib-|xkeysib-/i.test(String(s || ""));
}

/** Una entrada de process.env por nombre exacto o misma palabra en otro casing (Render/Git a veces alteran). */
function envRaw(key) {
  let v = process.env[key];
  if (v != null && String(v).trim() !== "") return String(v).trim();
  const lowFix = String(key || "").toLowerCase();
  for (const envKey of Object.keys(process.env)) {
    if (envKey.toLowerCase() === lowFix) {
      const v2 = process.env[envKey];
      if (v2 != null && String(v2).trim() !== "") return String(v2).trim();
    }
  }
  return "";
}

/** Render/Brevo a veces nombran distinto las variables; probamos alias comunes. */
function firstEnv(keys) {
  for (const k of keys) {
    const v = envRaw(k);
    if (v !== "") return v;
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

/** Una sola variable en Render (JSON) evita errores de nombre: {"user":"…@smtp-brevo.com","pass":"xsmtpsib-…"} */
function readBundledSmtpFromEnv() {
  const raw = envRaw("BREVO_SMTP_JSON") || envRaw("SMTP_JSON") || envRaw("SMTP_CREDENTIALS_JSON");
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return {
      user: String(j.user || j.login || "").trim(),
      pass: String(j.pass || j.password || j.key || "").trim(),
    };
  } catch {
    return null;
  }
}

function looksLikeBrevoSmtpLogin(s) {
  return /@smtp-brevo\.com\s*$/i.test(String(s || "").trim());
}

/**
 * Login SMTP (…@smtp-brevo.com). Importante: si SMTP_USER trae por error la clave xsmtpsib,
 * no nos quedamos ahí: seguimos probando el resto de nombres (muchas guías de Brevo usan otros).
 * Si el login quedó en SMTP_PASS y la clave en SMTP_USER, también lo detectamos.
 */
function getSmtpLoginOnly() {
  const bundled = readBundledSmtpFromEnv();
  if (bundled && bundled.user && !looksLikeBrevoSecret(bundled.user)) return bundled.user;

  const keys = ["BREVO_SMTP_LOGIN", "SMTP_LOGIN", "MAIL_USER", "EMAIL_USER", "SMTP_USER"];
  for (const k of keys) {
    const u = envRaw(k);
    if (u && !looksLikeBrevoSecret(u)) return u;
  }
  const passSlot = envRaw("SMTP_PASS");
  if (passSlot && !looksLikeBrevoSecret(passSlot) && looksLikeBrevoSmtpLogin(passSlot)) return passSlot;

  let u = String(SMTP_FALLBACK_LOGIN || "").trim();
  if (u && !looksLikeBrevoSecret(u)) return u;
  u = String(SMTP_FALLBACK_USER || "").trim();
  if (u && !looksLikeBrevoSecret(u)) return u;
  const j = readSmtpJsonFile();
  u = String(j.user || j.login || "").trim();
  if (u && !looksLikeBrevoSecret(u)) return u;
  return "";
}

/**
 * Valor "usuario" para auth (puede ser la clave si está mal colocada; createTransporter lo corrige).
 * Importante: si solo existe SMTP_USER con xsmtpsib, antes quedaba "" y fallaba siempre.
 */
function getSmtpUser() {
  const bundled = readBundledSmtpFromEnv();
  if (bundled && bundled.user) return bundled.user;

  let u = getSmtpLoginOnly();
  if (u) return u;
  u = String(SMTP_FALLBACK_USER || "").trim();
  if (!u) u = readSmtpJsonFile().user;
  if (!u) u = envRaw("SMTP_USER");
  if (!u) u = envRaw("BREVO_SMTP_LOGIN");
  return u;
}

function getSmtpPass() {
  const bundled = readBundledSmtpFromEnv();
  if (bundled && bundled.pass) return bundled.pass;

  const passKeys = [
    "SMTP_PASS",
    "SMTP_PASSWORD",
    "BREVO_SMTP_KEY",
    "BREVO_SMTP_PASSWORD",
    "SMTP_KEY",
    "MAIL_PASSWORD",
    "EMAIL_PASSWORD",
  ];
  for (const k of passKeys) {
    const v = envRaw(k);
    if (!v) continue;
    if (!looksLikeBrevoSecret(v) && looksLikeBrevoSmtpLogin(v)) continue;
    return v;
  }
  const maybeKeyInUser = envRaw("SMTP_USER");
  if (looksLikeBrevoSecret(maybeKeyInUser)) return maybeKeyInUser;

  let p = String(SMTP_FALLBACK_PASS || "").trim();
  if (!p) p = readSmtpJsonFile().pass;
  return p;
}

/** Si guardaste la clave por error en "usuario", recuperarla para auth. */
function brevoPassFromMisassignedUser(rawUser, rawPass) {
  if (looksLikeBrevoSecret(rawUser)) return rawUser;
  if (looksLikeBrevoSecret(rawPass)) return rawPass;
  return rawPass;
}

function getFromEmail() {
  let f = firstEnv(["FROM_EMAIL", "MAIL_FROM", "SMTP_FROM"]);
  if (!f) f = String(SMTP_FALLBACK_FROM || "").trim();
  if (!f) f = readSmtpJsonFile().from;
  f = (f || "").trim();
  // A veces se pega la clave SMTP en FROM_EMAIL; eso puede disparar errores raros de DNS.
  if (looksLikeBrevoSecret(f)) f = "";
  return f || getSmtpLoginOnly() || getSmtpUser();
}

const BREVO_SMTP_RELAY = "smtp-relay.brevo.com";

function normalizeSmtpHost(raw) {
  let h = String(raw || "")
    .replace(/^\uFEFF/, "")
    .trim();
  const lower = h.toLowerCase();
  // Clave API pegada por error como "host" (EBADNAME en DNS)
  if (lower.includes("xsmtpsib-") || lower.includes("xkeysib-")) {
    return BREVO_SMTP_RELAY;
  }
  if (h && !h.includes(".")) {
    return BREVO_SMTP_RELAY;
  }
  return h || BREVO_SMTP_RELAY;
}

function getSmtpHost() {
  let h = firstEnv(["SMTP_HOST"]);
  if (!h) h = readSmtpJsonFile().host;
  return normalizeSmtpHost(h);
}

function getSmtpPort() {
  let p = firstEnv(["SMTP_PORT"]);
  if (!p) p = readSmtpJsonFile().port;
  const n = parseInt(String(p || "587"), 10);
  return Number.isFinite(n) && n > 0 ? n : 587;
}

function createTransporter() {
  let user = getSmtpUser();
  let pass = getSmtpPass();

  if (looksLikeBrevoSecret(user) && looksLikeBrevoSecret(pass)) {
    pass = user === pass ? user : pass;
    user = getSmtpLoginOnly();
  } else if (looksLikeBrevoSecret(user)) {
    pass = brevoPassFromMisassignedUser(user, pass);
    user = getSmtpLoginOnly();
  }

  if (looksLikeBrevoSecret(user) && !looksLikeBrevoSecret(pass)) {
    const tmp = user;
    user = pass;
    pass = tmp;
  }

  const host = normalizeSmtpHost(getSmtpHost());
  const port = getSmtpPort();

  if (!user || !pass) {
    throw new Error(
      "Error SMTP: falta login o clave. En Render → Environment usa SMTP_USER (login …@smtp-brevo.com) y SMTP_PASS (clave xsmtpsib-), o una sola variable BREVO_SMTP_JSON con JSON {\"user\":\"…\",\"pass\":\"…\"}. Guarda y haz Manual Deploy."
    );
  }
  if (looksLikeBrevoSecret(user)) {
    throw new Error(
      "Error SMTP: el usuario debe ser el login SMTP (ej. a62653001@smtp-brevo.com), no la clave xsmtpsib-."
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
    hasSmtpLogin: Boolean(getSmtpLoginOnly()),
    hasSmtpUser: hasUser,
    hasSmtpPass: hasPass,
    hasSmtpJsonFile: fileOk,
    hasEnvFile: envFileOk,
    /** Si falta algo, en Render → Environment crea SMTP_USER y SMTP_PASS y pulsa Save + Redeploy. */
    renderEnvHint: {
      SMTP_USER_set: Boolean(envRaw("SMTP_USER")),
      SMTP_PASS_set: Boolean(envRaw("SMTP_PASS")),
      BREVO_SMTP_JSON_set: Boolean(envRaw("BREVO_SMTP_JSON")),
    },
    /** Nombres de variables presentes (sin valores), por si hay un typo */
    envKeyNamesMatching: Object.keys(process.env).filter((k) =>
      /^(SMTP|BREVO|MAIL_|EMAIL_|FROM_)/i.test(k)
    ),
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
  const okLogin = Boolean(getSmtpLoginOnly());
  const okPass = Boolean(getSmtpPass());
  if (!okLogin || !okPass) {
    console.warn(
      "[SMTP] Falta login o clave en este servidor. Render: Environment → SMTP_USER (…@smtp-brevo.com) y SMTP_PASS (xsmtpsib-…), luego Manual Deploy."
    );
  }
});
