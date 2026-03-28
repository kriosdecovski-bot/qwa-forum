const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

async function sendVerificationCode(email, code) {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    console.log('[MAIL] Почта не настроена, пропускаем отправку');
    return false;
  }
  try {
    await transporter.sendMail({
      from: process.env.MAIL_USER,
      to: email,
      subject: 'QWA Forum -- Код подтверждения',
      html: '<div style="font-family:monospace;padding:20px;background:#f5f5f5;border:2px solid #222;max-width:400px;">' +
        '<h2 style="text-align:center;">QWA FORUM</h2><hr>' +
        '<p>Ваш код подтверждения:</p>' +
        '<div style="text-align:center;padding:15px;">' +
        '<span style="font-size:28px;font-weight:bold;letter-spacing:6px;background:#e0e0e0;padding:8px 16px;border:2px solid #222;">' + code + '</span>' +
        '</div><p style="font-size:12px;color:#888;">Код действителен 10 минут.</p></div>'
    });
    console.log('[MAIL] Код отправлен на', email);
    return true;
  } catch (err) {
    console.error('[MAIL] Ошибка:', err.message);
    return false;
  }
}

async function sendReplyNotification(email, boardSlug, threadId, threadSubject, replyAuthor) {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) return false;
  try {
    const url = (process.env.SITE_URL || 'http://localhost:3000') + '/' + boardSlug + '/thread/' + threadId;
    await transporter.sendMail({
      from: process.env.MAIL_USER,
      to: email,
      subject: 'QWA -- Новый ответ в теме "' + (threadSubject || 'Thread #' + threadId) + '"',
      html: '<div style="font-family:monospace;padding:20px;background:#f5f5f5;border:2px solid #222;max-width:400px;">' +
        '<h2 style="text-align:center;">QWA FORUM</h2><hr>' +
        '<p><strong>' + replyAuthor + '</strong> ответил в вашей теме:</p>' +
        '<p><strong>"' + (threadSubject || 'Thread #' + threadId) + '"</strong></p>' +
        '<div style="text-align:center;padding:10px;">' +
        '<a href="' + url + '" style="background:#222;color:#fff;padding:8px 20px;text-decoration:none;">Смотреть тему</a>' +
        '</div></div>'
    });
    return true;
  } catch (err) {
    console.error('[MAIL] Ошибка уведомления:', err.message);
    return false;
  }
}

module.exports = { sendVerificationCode, sendReplyNotification };