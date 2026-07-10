/*
 * Customer wallet endpoints (api-endpoint-specifications §/customers/{id}/wallet). Read
 * gated by `wallets.read`; the limit write (PATCH) gated by
 * `wallets.manage-limits` — the canonical taxonomy name for this route (aligned
 * the code to the taxonomy and retired the undocumented `wallets.manage`). Responses
 * wrapped by the global envelope.
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { WalletDetailDto } from './dto/wallet.dto';
import { UpdateWalletLimitsDto } from './dto/update-wallet-limits.dto';
import { WalletsService } from './wallets.service';

/**
 * Write-class throttle: 30/min/IP — tighter than the global 100/min read budget (app.module.ts),
 * looser than the 10/min auth class. Mirrors the customer write routes. Honored only when
 * rate-limiting is on (THROTTLE_DISABLED unset; disabled in integration tests).
 */
const WRITE_THROTTLE = { default: { limit: 30, ttl: 60_000 } } as const;

@ApiTags('wallets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('customers')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get(':id/wallet')
  @RequirePermissions('wallets.read')
  @ApiOkResponse({ type: WalletDetailDto, description: "The customer's default wallet (balance + limits)." })
  getForCustomer(@Param('id', ParseUUIDPipe) id: string): Promise<WalletDetailDto> {
    return this.wallets.getForCustomer(id);
  }

  @Patch(':id/wallet')
  @RequirePermissions('wallets.manage-limits')
  @Throttle(WRITE_THROTTLE)
  @ApiOkResponse({ type: WalletDetailDto, description: "Updates the customer's wallet limits (rowVersion-guarded)." })
  updateLimits(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWalletLimitsDto,
    @CurrentUser() actor: AuthPrincipal,
  ): Promise<WalletDetailDto> {
    return this.wallets.updateLimits(id, dto, actor);
  }
}
