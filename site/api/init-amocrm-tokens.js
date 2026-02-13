// API для инициализации токенов amoCRM
// Используется один раз для сохранения первых токенов в Redis
import { createClient } from 'redis';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { secret, access_token, refresh_token } = req.body;

  if (secret !== process.env.INIT_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!access_token || !refresh_token) {
    res.status(400).json({ error: 'Missing access_token or refresh_token' });
    return;
  }

  let redis = null;

  try {
    redis = createClient({ url: process.env.KV_URL || process.env.REDIS_URL });
    await redis.connect();

    await redis.set('mirprava:amocrm_access_token', access_token);
    await redis.set('mirprava:amocrm_refresh_token', refresh_token);
    await redis.set('mirprava:amocrm_token_updated_at', new Date().toISOString());

    res.status(200).json({
      success: true,
      message: 'Tokens initialized successfully',
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error initializing tokens:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (redis) {
      await redis.quit().catch(() => {});
    }
  }
}
