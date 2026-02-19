// Vercel Cron Job для профилактического обновления токенов amoCRM
// Запускается ежедневно в 6:00 UTC
// v2: алерты в Telegram при сбоях
import { createClient } from 'redis';

const AMOCRM_SUBDOMAIN = 'mirpravakz';
const AMOCRM_INTEGRATION_ID = '9bd49bc3-25e1-4f22-a18d-cbce40fdbee3';
const AMOCRM_SECRET_KEY = '4VyxGkzafwJKyTbEKS23z2aDyTh13e36VrlRW00BnZ7fzirh0FafnCydWQJkQBxi';
const AMOCRM_REDIRECT_URI = 'https://mirprava.kz';

const TELEGRAM_BOT_TOKEN = '8565426544:AAGEAyyt-bJ0YEhKZu5pTaAx932A_jCKBcY';
const TELEGRAM_CHAT_ID = '-5279467001';

async function sendTelegramAlert(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram alert failed:', e); }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let redis = null;

  try {
    redis = createClient({
      url: process.env.KV_URL || process.env.REDIS_URL,
      socket: { connectTimeout: 5000 }
    });
    await redis.connect();

    const refreshToken = await redis.get('mirprava:amocrm_refresh_token');

    if (!refreshToken) {
      const msg = '🔴 <b>CRON amoCRM:</b> refresh-токен не найден в Redis. Интеграция не работает! Нужна переинициализация.';
      console.error('No refresh token found in Redis');
      await sendTelegramAlert(msg);
      res.status(500).json({ success: false, error: 'No refresh token found' });
      return;
    }

    const tokenUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`;

    // Попытка обновления с ретраем
    let data;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: AMOCRM_INTEGRATION_ID,
            client_secret: AMOCRM_SECRET_KEY,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            redirect_uri: AMOCRM_REDIRECT_URI
          })
        });

        data = await response.json();

        if (data.access_token) break;

        console.error(`Cron refresh attempt ${attempt} failed:`, data);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      } catch (fetchError) {
        console.error(`Cron refresh attempt ${attempt} error:`, fetchError);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        data = { error: fetchError.message };
      }
    }

    if (data && data.access_token) {
      await Promise.all([
        redis.set('mirprava:amocrm_access_token', data.access_token),
        redis.set('mirprava:amocrm_refresh_token', data.refresh_token),
        redis.set('mirprava:amocrm_token_updated_at', new Date().toISOString())
      ]);

      console.log('Tokens refreshed successfully at', new Date().toISOString());
      res.status(200).json({
        success: true,
        message: 'Tokens refreshed successfully',
        updated_at: new Date().toISOString()
      });
    } else {
      const msg = `🔴 <b>CRON amoCRM:</b> не удалось обновить токен (2 попытки).\n\n` +
        `<b>Ответ:</b> ${JSON.stringify(data).slice(0, 300)}\n\n` +
        `Заявки с сайта будут попадать только в Telegram, но НЕ в amoCRM!`;
      console.error('Token refresh failed after retries:', data);
      await sendTelegramAlert(msg);
      res.status(500).json({ success: false, error: 'Token refresh failed', details: data });
    }
  } catch (error) {
    const msg = `🔴 <b>CRON amoCRM:</b> критическая ошибка.\n\n` +
      `<b>Ошибка:</b> ${error.message}\n\n` +
      `Заявки с сайта будут попадать только в Telegram, но НЕ в amoCRM!`;
    console.error('Cron job error:', error);
    await sendTelegramAlert(msg);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (redis) {
      await redis.quit().catch(() => {});
    }
  }
}
