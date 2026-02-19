// Vercel Serverless Function для отправки заявок в Telegram и amoCRM
// v2: self-healing — превентивный refresh, retry, таймауты
import { createClient } from 'redis';

export default async function handler(req, res) {
  // Настройки Telegram бота
  const TELEGRAM_BOT_TOKEN = '8565426544:AAGEAyyt-bJ0YEhKZu5pTaAx932A_jCKBcY';
  const TELEGRAM_CHAT_ID = '-5279467001';
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Настройки amoCRM
  const AMOCRM_SUBDOMAIN = 'mirpravakz';
  const AMOCRM_INTEGRATION_ID = '9bd49bc3-25e1-4f22-a18d-cbce40fdbee3';
  const AMOCRM_SECRET_KEY = '4VyxGkzafwJKyTbEKS23z2aDyTh13e36VrlRW00BnZ7fzirh0FafnCydWQJkQBxi';
  const AMOCRM_REDIRECT_URI = 'https://mirprava.kz';

  // Воронка для новых заявок
  const AMOCRM_PIPELINE_ID = 10539470;

  // Токен обновляем если старше 20 часов (expires через 24ч)
  const TOKEN_MAX_AGE_MS = 20 * 60 * 60 * 1000;

  // Redis клиент с таймаутом подключения
  let redis = null;

  async function getRedisClient() {
    if (!redis) {
      redis = createClient({
        url: process.env.KV_URL || process.env.REDIS_URL,
        socket: { connectTimeout: 5000 }
      });
      redis.on('error', err => console.error('Redis error:', err));
      await redis.connect();
    }
    return redis;
  }

  // Получение токенов + метаданных из Redis
  async function getTokens() {
    try {
      const client = await getRedisClient();
      const [accessToken, refreshToken, updatedAt] = await Promise.all([
        client.get('mirprava:amocrm_access_token'),
        client.get('mirprava:amocrm_refresh_token'),
        client.get('mirprava:amocrm_token_updated_at')
      ]);
      return { accessToken, refreshToken, updatedAt };
    } catch (error) {
      console.error('Error getting tokens from Redis:', error);
      return { accessToken: null, refreshToken: null, updatedAt: null };
    }
  }

  // Сохранение токенов + timestamp в Redis
  async function saveTokens(accessToken, refreshToken) {
    try {
      const client = await getRedisClient();
      await Promise.all([
        client.set('mirprava:amocrm_access_token', accessToken),
        client.set('mirprava:amocrm_refresh_token', refreshToken),
        client.set('mirprava:amocrm_token_updated_at', new Date().toISOString())
      ]);
      return true;
    } catch (error) {
      console.error('Error saving tokens to Redis:', error);
      return false;
    }
  }

  // Обновление amoCRM токена с ретраем (до 2 попыток)
  async function refreshAmoCRMToken(currentRefreshToken, attempt = 1) {
    try {
      const tokenUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`;

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: AMOCRM_INTEGRATION_ID,
          client_secret: AMOCRM_SECRET_KEY,
          grant_type: 'refresh_token',
          refresh_token: currentRefreshToken,
          redirect_uri: AMOCRM_REDIRECT_URI
        })
      });

      const data = await response.json();

      if (data.access_token) {
        await saveTokens(data.access_token, data.refresh_token);
        return {
          success: true,
          accessToken: data.access_token,
          refreshToken: data.refresh_token
        };
      }

      console.error(`Token refresh failed (attempt ${attempt}):`, data);

      // Retry один раз через 1 секунду
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
        return refreshAmoCRMToken(currentRefreshToken, attempt + 1);
      }

      return { success: false, error: data };
    } catch (error) {
      console.error(`Token refresh error (attempt ${attempt}):`, error);

      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
        return refreshAmoCRMToken(currentRefreshToken, attempt + 1);
      }

      return { success: false, error: error.message };
    }
  }

  // Проверка: нужно ли превентивно обновить токен
  function isTokenStale(updatedAt) {
    if (!updatedAt) return true;
    const age = Date.now() - new Date(updatedAt).getTime();
    return age > TOKEN_MAX_AGE_MS;
  }

  // Отправка алерта в Telegram при ошибке amoCRM
  async function notifyAmoCRMError(name, phone, reason, timestamp) {
    try {
      const alertMsg = `⚠️ <b>amoCRM ОШИБКА</b>\n\n` +
        `Заявка от <b>${name}</b> (${phone}) отправлена в Telegram, но НЕ попала в amoCRM.\n\n` +
        `<b>Причина:</b> ${reason}\n` +
        `<b>Время:</b> ${timestamp}`;
      await fetch(telegramApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: alertMsg, parse_mode: 'HTML' })
      });
    } catch (e) { console.error('Failed to send amoCRM alert:', e); }
  }

  // CORS заголовки
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ success: false, message: 'Метод не разрешен' }); return; }

  try {
    const data = req.body;

    if (!data.name || !data.phone) {
      res.status(400).json({ success: false, message: 'Заполните все обязательные поля' });
      return;
    }

    // Извлечение данных
    const name = String(data.name || '').trim();
    const phone = String(data.phone || '').trim();
    const messenger = String(data.messenger || '').trim();
    const page = String(data.page || '').trim();
    const role = String(data.role || '').trim();
    const risk_level = String(data.risk_level || '').trim();

    const utm_source = String(data.utm_source || 'Прямой заход').trim();
    const utm_medium = String(data.utm_medium || '-').trim();
    const utm_campaign = String(data.utm_campaign || '-').trim();
    const utm_content = String(data.utm_content || '-').trim();
    const utm_ad_name = String(data.utm_ad_name || '-').trim();

    const page_url = String(data.page_url || '-').trim();
    const referrer = String(data.referrer || '-').trim();
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

    // Формирование сообщения для Telegram
    let message = "🔔 <b>Новая заявка с сайта Мир Права</b>\n\n";
    message += `👤 <b>Имя:</b> ${name}\n`;
    message += `📱 <b>Телефон:</b> ${phone}\n`;

    if (messenger) message += `💬 <b>Мессенджер:</b> ${messenger}\n`;

    if (page === 'main') {
      message += `📄 <b>Страница:</b> Главная\n`;
      if (role) message += `👥 <b>Роль:</b> ${role === 'employer' ? 'Работодатель' : 'Работник'}\n`;
    } else if (page === 'audit') {
      message += `📄 <b>Страница:</b> Аудит кадров\n`;
      if (risk_level) message += `⚠️ <b>Уровень риска:</b> ${risk_level}\n`;
    } else if (page === 'worker') {
      message += `📄 <b>Страница:</b> Работник (лендинг)\n`;
    }

    message += `🕐 <b>Время:</b> ${timestamp}\n\n`;
    message += "📊 <b>UTM-метки:</b>\n";
    message += `├ Source: ${utm_source}\n`;
    message += `├ Medium: ${utm_medium}\n`;
    message += `├ Campaign: ${utm_campaign}\n`;
    message += `├ Content: ${utm_content}\n`;
    message += `└ Ad Name: ${utm_ad_name}\n\n`;
    message += "🌐 <b>Дополнительно:</b>\n";
    message += `├ Страница: ${page_url}\n`;
    message += `└ Источник перехода: ${referrer}\n`;

    // Отправка в Telegram
    const telegramResponse = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });

    const telegramData = await telegramResponse.json();

    if (!telegramData.ok) {
      console.error('Telegram API error:', telegramData);
      res.status(500).json({ success: false, message: 'Ошибка отправки заявки в Telegram' });
      return;
    }

    // ====== ОТПРАВКА В amoCRM (self-healing) ======
    try {
      let { accessToken, refreshToken, updatedAt } = await getTokens();

      if (!accessToken || !refreshToken) {
        console.error('No tokens found in Redis');
        await notifyAmoCRMError(name, phone, 'Токены не найдены в Redis. Нужно переинициализировать через /api/init-amocrm-tokens', timestamp);
        res.status(200).json({ success: true, message: 'Telegram OK, amoCRM: нет токенов' });
        return;
      }

      // Превентивное обновление: если токен старше 20 часов — обновляем ДО запроса
      if (isTokenStale(updatedAt)) {
        console.log('Token is stale, proactively refreshing...');
        const refreshResult = await refreshAmoCRMToken(refreshToken);
        if (refreshResult.success) {
          accessToken = refreshResult.accessToken;
          refreshToken = refreshResult.refreshToken;
          console.log('Proactive token refresh succeeded');
        } else {
          console.warn('Proactive refresh failed, trying with current token anyway');
        }
      }

      // Формирование данных для amoCRM
      const contactData = {
        name: name,
        custom_fields_values: [{
          field_code: 'PHONE',
          values: [{ value: phone, enum_code: 'WORK' }]
        }]
      };

      const leadCustomFields = [
        { field_id: 3722207, values: [{ value: utm_source }] },
        { field_id: 3722209, values: [{ value: utm_medium }] },
        { field_id: 3722211, values: [{ value: utm_campaign }] },
        { field_id: 3722213, values: [{ value: utm_content }] },
        { field_id: 3722215, values: [{ value: utm_ad_name }] },
        { field_id: 3722231, values: [{ value: page_url }] }
      ];

      let leadName = 'Заявка: ';
      if (page === 'audit') {
        leadName += 'Аудит кадров';
        if (risk_level) leadName += ` (${risk_level})`;
      } else if (role === 'employer') {
        leadName += 'Работодатель';
      } else if (role === 'worker') {
        leadName += 'Работник';
      } else {
        leadName += 'Сайт';
      }

      const nowUnix = Math.floor(Date.now() / 1000);
      const unsortedData = [{
        source_name: 'Сайт mirprava.kz',
        source_uid: 'mirprava-website-form',
        pipeline_id: AMOCRM_PIPELINE_ID,
        created_at: nowUnix,
        _embedded: {
          leads: [{ name: leadName, custom_fields_values: leadCustomFields }],
          contacts: [contactData]
        },
        metadata: {
          form_id: 'mirprava_lead_form',
          form_sent_at: nowUnix,
          form_name: leadName,
          form_page: page_url,
          referer: referrer
        }
      }];

      // Функция отправки в amoCRM
      async function sendToAmoCRM(token) {
        return await fetch(`https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/unsorted/forms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(unsortedData)
        });
      }

      // Попытка 1
      let amoResponse = await sendToAmoCRM(accessToken);

      // Если 401 — токен протух, обновляем и пробуем снова
      if (amoResponse.status === 401) {
        console.log('amoCRM 401, refreshing token...');
        const refreshResult = await refreshAmoCRMToken(refreshToken);

        if (refreshResult.success) {
          accessToken = refreshResult.accessToken;
          amoResponse = await sendToAmoCRM(accessToken);
        } else {
          await notifyAmoCRMError(name, phone, 'Токен 401 + refresh не сработал (2 попытки). Refresh-токен мог протухнуть.', timestamp);
          res.status(200).json({ success: true, message: 'Telegram OK, amoCRM: refresh failed' });
          return;
        }
      }

      // Если 429 (rate limit) — ждём и пробуем ещё раз
      if (amoResponse.status === 429) {
        console.log('amoCRM 429 rate limit, waiting 2s...');
        await new Promise(r => setTimeout(r, 2000));
        amoResponse = await sendToAmoCRM(accessToken);
      }

      let amoResult;
      try {
        amoResult = await amoResponse.json();
      } catch (e) {
        amoResult = { parseError: true, status: amoResponse.status };
      }

      const leadId = amoResult?._embedded?.unsorted?.[0]?._embedded?.leads?.[0]?.id;

      if (amoResponse.ok && leadId) {
        console.log('amoCRM lead created, ID:', leadId);
        res.status(200).json({ success: true, message: 'Заявка отправлена в Telegram и amoCRM!' });
      } else {
        console.error('amoCRM error:', amoResponse.status, amoResult);
        await notifyAmoCRMError(name, phone, `HTTP ${amoResponse.status}: ${JSON.stringify(amoResult).slice(0, 200)}`, timestamp);
        res.status(200).json({ success: true, message: 'Telegram OK, amoCRM error' });
      }
    } catch (amoError) {
      console.error('amoCRM exception:', amoError);
      await notifyAmoCRMError(name, phone, 'Исключение: ' + (amoError.message || String(amoError)).slice(0, 200), timestamp);
      res.status(200).json({ success: true, message: 'Telegram OK, amoCRM exception' });
    }
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  } finally {
    if (redis) {
      await redis.quit().catch(() => {});
    }
  }
}
