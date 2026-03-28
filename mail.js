const nodemailer = require('nodemailer');

// === НАСТРОЙ СВОЮ ПОЧТУ ===
// Создай отдельный Gmail аккаунт для форума
// Включи "App Passwords" в настройках Google:
// https://myaccount.google.com/apppasswords

const MAIL_USER = process.env.MAIL_USER || 'your.forum.email@gmail.com';
const MAIL_PASS = process.env.MAIL_PASS || 'your-app-password';
const MAIL_FROM = process.env.MAIL_FROM || 'QWA Forum <your.forum.email@gmail.com>';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS
  }
});

// Отправка кода подтверждения
async function sendVerificationCode(email, code) {
  try {
    await transporter.sendMail({
      from: MAIL_FROM,
      to: email,
      subject: 'QWA Forum -- Kod podtverzhdeniya',
      text: `Vash kod podtverzhdeniya: ${code}\n\nEsli vy ne registrirovalis na QWA Forum, proignoriruyte eto pismo.`,
      html: `
        <div style="font-family:monospace;max-width:500px;margin:0 auto;padding:20px;background:#f5f5f5;border:2px solid #222;">
          <h2 style="color:#222;text-align:center;">QWA FORUM</h2>
          <hr style="border:1px solid #222;">
          <p style="font-size:14px;color:#333;">Vash kod podtverzhdeniya:</p>
          <div style="text-align:center;padding:20px;">
            <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#000;background:#e0e0e0;padding:10px 20px;border:2px solid #222;">${code}</span>
          </div>
          <p style="font-size:12px;color:#888;">Kod deystvitelen 10 minut.</p>
          <hr style="border:1px solid #ddd;">
          <p style="font-size:11px;color:#aaa;text-align:center;">QWA Forum -- Anonymous Text Forum</p>
        </div>
      `
    });
    console.log('[MAIL] Code sent to', email);
    return true;
  } catch (err) {
    console.error('[MAIL] Error:', err.message);
    return false;
  }
}

// Уведомление об ответе в треде
async function sendReplyNotification(email, boardSlug, threadId, threadSubject, replyAuthor) {
  try {
    const threadUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/${boardSlug}/thread/${threadId}`;
    await transporter.sendMail({
      from: MAIL_FROM,
      to: email,
      subject: `QWA -- Novyy otvet v teme "${threadSubject || 'Thread #' + threadId}"`,
      text: `Polzovatel ${replyAuthor} otvetil v vashey teme.\n\nSmotret: ${threadUrl}`,
      html: `
        <div style="font-family:monospace;max-width:500px;margin:0 auto;padding:20px;background:#f5f5f5;border:2px solid #222;">
          <h2 style="color:#222;text-align:center;">QWA FORUM</h2>
          <hr style="border:1px solid #222;">
          <p style="font-size:14px;color:#333;">
            <strong>${replyAuthor}</strong> otvetil v teme 
            <strong>"${threadSubject || 'Thread #' + threadId}"</strong>
          </p>
          <div style="text-align:center;padding:15px;">
            <a href="${threadUrl}" style="background:#222;color:#fff;padding:10px 25px;text-decoration:none;font-weight:bold;">Smotret temu</a>
          </div>
          <hr style="border:1px solid #ddd;">
          <p style="font-size:11px;color:#aaa;text-align:center;">QWA Forum</p>
        </div>
      `
    });
    console.log('[MAIL] Reply notification sent to', email);
    return true;
  } catch (err) {
    console.error('[MAIL] Notification error:', err.message);
    return false;
  }
}

module.exports = { sendVerificationCode, sendReplyNotification };