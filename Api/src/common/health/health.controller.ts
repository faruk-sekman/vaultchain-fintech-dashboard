/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Liveness probe. Public, no auth — returns process health only (no secrets, no DB
 * detail). Response is wrapped by the global envelope interceptor as `{ data, meta }`.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

interface HealthStatus {
  status: 'ok';
  uptimeSeconds: number;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Public() // exempt the liveness probe from the global JwtAuthGuard (D-12)
  @Get()
  @ApiOkResponse({ description: 'Service is live.' })
  check(): HealthStatus {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }
}
