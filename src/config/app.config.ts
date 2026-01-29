import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10) || 3000,
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  maxRecommendations: parseInt(process.env.MAX_RECOMMENDATIONS || '5', 10) || 5,
  sessionTtl: parseInt(process.env.SESSION_TTL || '1800', 10) || 1800,
}));