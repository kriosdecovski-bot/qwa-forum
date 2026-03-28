const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000
    });
  }
  return transporter;
}

async function sendVerificationCode(email, code) {
  const t = getTransporter();
  if (!t) { console.log('[MAIL] Не настроена'); return false; }
  try {
    await t.sendMail({
      from: process.env.MAIL_USER, to: email,
      subject: 'QWA Forum -- Код подтверждения',
      html: '<div style="font-family:monospace;padding:20px;background:#f5f5f5;border:2px solid #222;max-width:400px;"><h2 style="text-align:center;">QWA FORUM</h2><hr><p>Ваш код:</p><div style="text-align:center;padding:15px;"><span style="font-size:28px;font-weight:bold;letter-spacing:6px;background:#e0e0e0;padding:8px 16px;border:2px solid #222;">' + code + '</span></div><p style="font-size:12px;color:#888;">Код действителен 10 минут.</p></div>'
    });
    console.log('[MAIL] Код отправлен на', email);
    return true;
  } catch (err) {
    console.error('[MAIL] Ошибка:', err.message);
    return false;
  }
}

async function sendReplyNotification(email, boardSlug, threadId, threadSubject, replyAuthor) {
  const t = getTransporter();
  if (!t) return false;
  try {
    const url = (process.env.SITE_URL || 'http://localhost:3000') + '/' + boardSlug + '/thread/' + threadId;
    await t.sendMail({
      from: process.env.MAIL_USER, to: email,
      subject: 'QWA -- Ответ в теме "' + (threadSubject || '#' + threadId) + '"',
      html: '<div style="font-family:monospace;padding:20px;background:#f5f5f5;border:2px solid #222;max-width:400px;"><h2 style="text-align:center;">QWA</h2><hr><p><strong>' + replyAuthor + '</strong> ответил в теме <strong>"' + (threadSubject || '#' + threadId) + '"</strong></p><div style="text-align:center;padding:10px;"><a href="' + url + '" style="background:#222;color:#fff;padding:8px 20px;text-decoration:none;">Смотреть</a></div></div>'
    });
    return true;
  } catch (err) { return false; }
}

module.exports = { sendVerificationCode, sendReplyNotification };