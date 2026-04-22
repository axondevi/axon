import Redis from 'ioredis';
import { env } from '~/config';

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  console.error('[redis] error:', err.message);
});
