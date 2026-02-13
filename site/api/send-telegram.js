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

  // Воронка и этап для новых заявок
  const AMOCRM_PIPELINE_ID = 10539470; // "Воронка"
  const AMOCRM_STATUS_ID = 83152998;   // "Неразобранное"

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

      // Формирование данных для сделки с UTM-метками (field_id для надёжности)
      const leadCustomFields = [
        { field_id: 3691501, values: [{ value: utm_source }] },    // utm_source
        { field_id: 3691497, values: [{ value: utm_medium }] },    // utm_medium
        { field_id: 3691499, values: [{ value: utm_campaign }] },  // utm_campaign
        { field_id: 3691495, values: [{ value: utm_content }] },   // utm_content
        { field_id: 3691503, values: [{ value: utm_ad_name }] },   // utm_term (ad_name)
        { field_id: 3691509, values: [{ value: referrer }] },      // referrer
        { field_id: 3691505, values: [{ value: page_url }] }       // utm_referrer (page url)
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

      const leadData = {
        name: leadName,
        pipeline_id: AMOCRM_PIPELINE_ID,
        status_id: AMOCRM_STATUS_ID,
        custom_fields_values: leadCustomFields
      };

      // UTM-примечание
      const utmNote = `UTM Source: ${utm_source}\nUTM Medium: ${utm_medium}\nUTM Campaign: ${utm_campaign}\nUTM Content: ${utm_content}\nAd Name: ${utm_ad_name}\nСтраница: ${page_url}\nИсточник перехода: ${referrer}`;

      // Создание комплексной сущности (сделка + контакт)
      const amoData = [
        {
          ...leadData,
          _embedded: {
            contacts: [contactData]
          }
        }
      ];

      // Функция отправки в amoCRM
      async function sendToAmoCRM(token) {
        const amoUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/complex`;
        return await fetch(amoUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(amoData)
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
            res.status(200).json({
              success: true,
              message: 'Заявка отправлена в Telegram, но ошибка amoCRM'
            });
            return;
          }
        } else {
          console.error('Failed to refresh amoCRM token');
          res.status(200).json({
            success: true,
            message: 'Заявка отправлена в Telegram, но ошибка обновления токена amoCRM'
          });
          return;
        }
      }

      if (amoResponse.ok && amoResult[0]?.id) {
        // Добавляем примечание с UTM к сделке
        const leadId = amoResult[0].id;
        const noteUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}/notes`;

        await fetch(noteUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify([
            {
              note_type: 'common',
              params: {
                text: utmNote
              }
            }
          ])
        });

        res.status(200).json({
          success: true,
          message: 'Заявка отправлена в Telegram и amoCRM!'
        });
      } else {
        console.error('amoCRM API error:', amoResult);
        res.status(200).json({
          success: true,
          message: 'Заявка отправлена в Telegram, ошибка amoCRM'
        });
      }
    } catch (amoError) {
      console.error('amoCRM error:', amoError);
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
