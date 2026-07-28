import type { HealthResponse, ServiceName } from '@aiimage/shared-contracts';
import { sendJson } from './json.js';
import type { Route } from './router.js';

export type HealthRoutesOptions = {
  service: ServiceName;
  version: string;
  startedAt?: number;
};

export function createHealthRoutes(options: HealthRoutesOptions): Route[] {
  const startedAt = options.startedAt ?? Date.now();

  return [
    {
      method: 'GET',
      path: '/health',
      handle: (_req, res) => {
        const body: HealthResponse = {
          ok: true,
          service: options.service,
          version: options.version,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        };
        sendJson(res, 200, body);
      },
    },
    {
      method: 'GET',
      path: '/version',
      handle: (_req, res) => {
        sendJson(res, 200, {
          service: options.service,
          version: options.version,
        });
      },
    },
  ];
}
