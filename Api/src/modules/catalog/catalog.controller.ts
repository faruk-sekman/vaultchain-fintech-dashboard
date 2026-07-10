/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { CatalogService } from './catalog.service';
import { CurrencyCatalogDto } from './dto/currency.dto';

@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('currencies')
  @RequirePermissions('customers.read')
  @ApiOkResponse({ type: CurrencyCatalogDto, description: 'Active ISO-4217 currency catalog.' })
  listCurrencies(): Promise<CurrencyCatalogDto> {
    return this.catalog.listActiveCurrencies();
  }
}
