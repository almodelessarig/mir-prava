// Vercel Serverless Function для отправки заявок в Telegram и amoCRM
import { createClient } from 'redis';

export default async function handler(req, res) {
  // Настройки Telegram бота
  const TELEGRAM_BOT_TOKEN = '8565426544:AAGEAyyt-bJ0YEhKZu5pTaAx932A_jCKBcY';
  const TELEGRAM_CHAT_ID = '-5279467001';

  // Настройки amoCRM
  const AMOCRM_SUBDOMAIN = 'mirpravakz';
  const AMOCRM_INTEGRATION_ID = '9bd49bc3-25e1-4f22-a18d-cbce40fdbee3';
  const AMOCRM_SECRET_KEY = '4VyxGkzafwJKyTbEKS23z2aDyTh13e36VrlRW00BnZ7fzirh0FafnCydWQJkQBxi';
  const AMOCRM_REDIRECT_URI = 'https://mirprava.kz';

  // Воронка для новых заявок
  const AMOCRM_PIPELINE_ID = 10539470; // "Воронка"

  // Redis клиент
  let redis = null;

  async function getRedisClient() {
    if (!redis) {
      redis = createClient({ url: process.env.KV_URL || process.env.REDIS_URL });
      redis.on('error', err => console.error('Redis error:', err));
      await redis.connect();
    }
    return redis;
  }

  // Получение токенов из Redis
  async function getTokens() {
    try {
      const client = await getRedisClient();
      const accessToken = await client.get('mirprava:amocrm_access_token');
      const refreshToken = await client.get('mirprava:amocrm_refresh_token');
      return { accessToken, refreshToken };
    } catch (error) {
      console.error('Error getting tokens from Redis:', error);
      return { accessToken: null, refreshToken: null };
    }
  }

  // Сохранение токенов в Redis
  async function saveTokens(accessToken, refreshToken) {
    try {
      const client = await getRedisClient();
      await client.set('mirprava:amocrm_access_token', accessToken);
      await client.set('mirprava:amocrm_refresh_token', refreshToken);
      return true;
    } catch (error) {
      console.error('Error saving tokens to Redis:', error);
      return false;
    }
  }

  // Функция обновления amoCRM токена
  async function refreshAmoCRMToken(currentRefreshToken) {
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

      console.error('Token refresh failed:', data);
      return { success: false };
    } catch (error) {
      console.error('Token refresh error:', error);
      return { success: false };
    }
  }

  // CORS заголовки
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Обработка preflight запроса
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Проверка метода запроса
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Метод не разрешен' });
    return;
  }

  try {
    // Получение данных из запроса
    const data = req.body;

    // Валидация обязательных полей
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

    // UTM метки
    const utm_source = String(data.utm_source || 'Прямой заход').trim();
    const utm_medium = String(data.utm_medium || '-').trim();
    const utm_campaign = String(data.utm_campaign || '-').trim();
    const utm_content = String(data.utm_content || '-').trim();
    const utm_ad_name = String(data.utm_ad_name || '-').trim();

    // Дополнительные данные
    const page_url = String(data.page_url || '-').trim();
    const referrer = String(data.referrer || '-').trim();
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

    // Формирование сообщения для Telegram
    let message = "🔔 <b>Новая заявка с сайта Мир Права</b>\n\n";
    message += `👤 <b>Имя:</b> ${name}\n`;
    message += `📱 <b>Телефон:</b> ${phone}\n`;

    if (messenger) {
      message += `💬 <b>Мессенджер:</b> ${messenger}\n`;
    }

    if (page === 'main') {
      message += `📄 <b>Страница:</b> Главная\n`;
      if (role) message += `👥 <b>Роль:</b> ${role === 'employer' ? 'Работодатель' : 'Работник'}\n`;
    } else if (page === 'audit') {
      message += `📄 <b>Страница:</b> Аудит кадров\n`;
      if (risk_level) message += `⚠️ <b>Уровень риска:</b> ${risk_level}\n`;
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

    // Отправка сообщения в Telegram
    const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const telegramResponse = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });

    const telegramData = await telegramResponse.json();

    if (!telegramData.ok) {
      console.error('Telegram API error:', telegramData);
      res.status(500).json({
        success: false,
        message: 'Ошибка отправки заявки в Telegram'
      });
      return;
    }

    // Функция оповещения об ошибке amoCRM в Telegram
    async function notifyAmoCRMError(reason) {
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

    // Отправка данных в amoCRM
    try {
      // Проверяем, настроен ли amoCRM
      if (AMOCRM_INTEGRATION_ID === 'TODO_INTEGRATION_ID') {
        console.log('amoCRM not configured, skipping');
        res.status(200).json({
          success: true,
          message: 'Заявка отправлена в Telegram (amoCRM не настроен)'
        });
        return;
      }

      // Получаем токены из Redis
      let { accessToken, refreshToken } = await getTokens();

      if (!accessToken || !refreshToken) {
        console.error('No tokens found in Redis');
        await notifyAmoCRMError('Токены amoCRM не найдены в Redis. Нужно переинициализировать.');
        res.status(200).json({
          success: true,
          message: 'Заявка отправлена в Telegram, но токены amoCRM не настроены'
        });
        return;
      }

      // Формирование данных для контакта
      const contactData = {
        name: name,
        custom_fields_values: [
          {
            field_code: 'PHONE',
            values: [
              {
                value: phone,
                enum_code: 'WORK'
              }
            ]
          }
        ]
      };

      // UTM-поля для сделки — пользовательские поля (видимые в UI карточки)
      const leadCustomFields = [
        { field_id: 3722207, values: [{ value: utm_source }] },    // utm_source (text)
        { field_id: 3722209, values: [{ value: utm_medium }] },    // utm_medium (text)
        { field_id: 3722211, values: [{ value: utm_campaign }] },  // utm_campaign (text)
        { field_id: 3722213, values: [{ value: utm_content }] },   // utm_content (text)
        { field_id: 3722215, values: [{ value: utm_ad_name }] },   // utm_ad_name (text)
        { field_id: 3722231, values: [{ value: page_url }] }       // utm_referrer (text)
      ];

      // Название сделки с контекстом
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

      // Данные для unsorted/forms — заявка попадёт в "Неразобранное"
      // UTM-поля включены прямо в lead, без отдельного PATCH (PATCH выбивает из Неразобранного)
      const nowUnix = Math.floor(Date.now() / 1000);
      const unsortedData = [
        {
          source_name: 'Сайт mirprava.kz',
          source_uid: 'mirprava-website-form',
          pipeline_id: AMOCRM_PIPELINE_ID,
          created_at: nowUnix,
          _embedded: {
            leads: [
              {
                name: leadName,
                custom_fields_values: leadCustomFields
              }
            ],
            contacts: [contactData]
          },
          metadata: {
            form_id: 'mirprava_lead_form',
            form_sent_at: nowUnix,
            form_name: leadName,
            form_page: page_url,
            referer: referrer
          }
        }
      ];

      // Функция отправки в amoCRM (unsorted/forms)
      async function sendToAmoCRM(token) {
        const amoUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/unsorted/forms`;
        return await fetch(amoUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(unsortedData)
        });
      }

      // Первая попытка отправки
      let amoResponse = await sendToAmoCRM(accessToken);
      let amoResult = await amoResponse.json();

      // Если токен истёк (401), обновляем и пробуем снова
      if (amoResponse.status === 401) {
        console.log('amoCRM token expired, refreshing...');
        const refreshResult = await refreshAmoCRMToken(refreshToken);

        if (refreshResult.success) {
          accessToken = refreshResult.accessToken;
          amoResponse = await sendToAmoCRM(accessToken);
          amoResult = await amoResponse.json();

          if (!amoResponse.ok) {
            console.error('amoCRM API error after token refresh:', amoResult);
            await notifyAmoCRMError('Ошибка API amoCRM после обновления токена: ' + JSON.stringify(amoResult).slice(0, 200));
            res.status(200).json({
              success: true,
              message: 'Заявка отправлена в Telegram, но ошибка amoCRM'
            });
            return;
          }
        } else {
          console.error('Failed to refresh amoCRM token');
          await notifyAmoCRMError('Не удалось обновить refresh-токен. Нужна переинициализация.');
          res.status(200).json({
            success: true,
            message: 'Заявка отправлена в Telegram, но ошибка обновления токена amoCRM'
          });
          return;
        }
      }

      // Извлекаем ID сделки из ответа unsorted
      const leadId = amoResult?._embedded?.unsorted?.[0]?._embedded?.leads?.[0]?.id;

      if (amoResponse.ok && leadId) {
        console.log('Unsorted lead created, ID:', leadId);

        res.status(200).json({
          success: true,
          message: 'Заявка отправлена в Telegram и amoCRM!'
        });
      } else {
        console.error('amoCRM unsorted API error:', amoResult);
        await notifyAmoCRMError('Ошибка unsorted/forms: ' + JSON.stringify(amoResult).slice(0, 200));
        res.status(200).json({
          success: true,
          message: 'Заявка отправлена в Telegram, ошибка amoCRM'
        });
      }
    } catch (amoError) {
      console.error('amoCRM error:', amoError);
      await notifyAmoCRMError('Исключение: ' + (amoError.message || String(amoError)).slice(0, 200));
      res.status(200).json({
        success: true,
        message: 'Заявка отправлена в Telegram, ошибка amoCRM'
      });
    }
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      message: 'Ошибка сервера'
    });
  } finally {
    if (redis) {
      await redis.quit().catch(() => {});
    }
  }
}
