const nodemailer = require("nodemailer");

let transporter = null;

// Se resuelve recién al primer envío (no al importar el módulo) para que la
// falta de configuración de SMTP no rompa el arranque del servidor entero —
// solo las acciones que necesitan mandar un email fallan, con un mensaje claro.
const getTransporter = () => {
  if (transporter) return transporter;

  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP_USER/SMTP_PASS no están configurados: no se puede enviar email");
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
};

const sendMail = async ({ to, subject, html, text }) => {
  const from = `"Menú Digital" <${process.env.SMTP_USER}>`;
  await getTransporter().sendMail({ from, to, subject, html, text });
};

const CODE_LABELS = {
  baja: {
    subject: "Confirmá tu baja de servicio — Menú Digital",
    heading: "Confirmá la baja de tu servicio",
    body: "Recibimos un pedido para dar de baja tu cuenta y pasarla al plan Gratis. Si fuiste vos, usá este código para confirmarlo:",
  },
  arrepentimiento: {
    subject: "Confirmá tu arrepentimiento — Menú Digital",
    heading: "Confirmá tu solicitud de arrepentimiento",
    body: "Recibimos un pedido para reembolsar tu compra y bajar tu cuenta al plan Gratis. Si fuiste vos, usá este código para confirmarlo:",
  },
  verificacion_email: {
    subject: "Confirmá tu cuenta — Menú Digital",
    heading: "¡Bienvenido a Menú Digital!",
    body: "Ya casi terminás de crear tu cuenta. Usá este código en la app para verificar tu email:",
  },
  cambio_email: {
    subject: "Confirmá tu nuevo email — Menú Digital",
    heading: "Confirmá tu nuevo email de contacto",
    body: "Pediste cambiar el email de contacto de tu cuenta a esta casilla. Usá este código en la app para confirmarlo:",
  },
};

const sendConfirmationCodeEmail = async ({ to, code, action }) => {
  const labels = CODE_LABELS[action];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111;">
      <h2 style="margin:0 0 16px;">${labels.heading}</h2>
      <p>${labels.body}</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:4px;background:#f4f4f4;padding:16px;text-align:center;border-radius:8px;">${code}</p>
      <p>Este código vence en 15 minutos y solo puede usarse una vez.</p>
      <p>Si no pediste esto, ignorá este email — tu cuenta no va a sufrir ningún cambio.</p>
      <p style="color:#888;font-size:12px;margin-top:32px;">Menú Digital · menudigitalappsoporte@gmail.com</p>
    </div>
  `;
  await sendMail({
    to,
    subject: labels.subject,
    html,
    text: `${labels.body}\n\nCódigo: ${code}\n\nVence en 15 minutos y solo puede usarse una vez.`,
  });
};

module.exports = { sendMail, sendConfirmationCodeEmail };
