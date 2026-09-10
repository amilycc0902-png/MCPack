import { z } from 'zod';
import { buildApp } from './app.js';

const serverConfigSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

const config = serverConfigSchema.parse(process.env);
const app = buildApp();

try {
  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
