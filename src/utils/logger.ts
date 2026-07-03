// src/utils/logger.ts
// Shared pino logger — use this everywhere instead of console.log in production.
// In development it prints pretty human-readable output.
// In production (Railway) it emits structured JSON for log aggregation.

import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  transport:
    config.nodeEnv !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

// Scoped child loggers — carry a fixed context object into every log line
export const createLogger = (context: Record<string, string>) =>
  logger.child(context);
