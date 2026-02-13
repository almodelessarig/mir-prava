// Vercel Cron Job для профилактического обновления токенов amoCRM
// Запускается ежедневно в 6:00 UTC
import { createClient } from 'redis';

// Настройки amoCRM — TODO: заполнить реальными данными
const AMOCRM_SUBDOMAIN = 'mirprava'; // TODO: указать ваш поддомен amoCRM
const AMOCRM_INTEGRATION_ID = 'TODO_INTEGRATION_ID'; // TODO: ID интеграции
const AMOCRM_SECRET_KEY = 'TODO_SECRET_KEY'; // TODO: секретный ключ
const AMOCRM_REDIRECT_URI = 'https://mirprava.kz';

export default async function handler(req, res) {
  // Проверяем, что запрос от Vercel Cron
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Проверяем, настроен ли amoCRM
  if (AMOCRM_INTEGRATION_ID === 'TODO_INTEGRATION_ID') {
    res.status(200).json({ success: true, message: 'amoCRM not configured, skipping' });
    return;
  }

  let redis = null;

  try {
    redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();

    const refreshToken = await redis.get('amocrm_refresh_token');

    if (!refreshToken) {
      console.error('No refresh token found in Redis');
      res.status(500).json({ success: false, error: 'No refresh token found' });
      return;
    }

    const tokenUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`;

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

    const data = await response.json();

    if (data.access_token) {
      await redis.set('amocrm_access_token', data.access_token);
      await redis.set('amocrm_refresh_token', data.refresh_token);
      await redis.set('amocrm_token_updated_at', new Date().toISOString());

      console.log('Tokens refreshed successfully at', new Date().toISOString());
      res.status(200).json({
        success: true,
        message: 'Tokens refreshed successfully',
        updated_at: new Date().toISOString()
      });
    } else {
      console.error('Token refresh failed:', data);
      res.status(500).json({ success: false, error: 'Token refresh failed', details: data });
    }
  } catch (error) {
    console.error('Cron job error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (redis) {
      await redis.quit().catch(() => {});
    }
  }
}
