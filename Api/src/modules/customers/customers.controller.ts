/*
 * Customer endpoints (api-endpoint-specifications §/customers). Reads gated by
 * `customers.read`; writes (POST/PUT/DELETE) gated by `customers.manage`. Responses
 * are wrapped by the global envelope interceptor (`{ data, meta }`; the list keeps its
 * `{ data, page }` and gains `meta`). PII is masked by default — raw values never leave the service.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import {
  CredentialPreviewDto,
  CustomerDetailDto,
  PaginatedCustomerListDto,
  PaginatedKycVerificationListDto,
} from './dto/customer.dto';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer-write.dto';
import { CustomersService } from './customers.service';
import { parseReveal } from './customers.query';

/** Swagger doc for the shared `?reveal` query param. */
const REVEAL_QUERY = {
  name: 'reveal',
  required: false,
  type: Boolean,
  description:
    'true → return UNMASKED PII. Honored ONLY for holders of `customers.pii.reveal`; otherwise silently masked (default-deny). Every effective reveal is audited.',
} as const;

/**
 * Write-class throttle: 30/min/IP — tighter than the global 100/min read budget (app.module.ts)
 * and looser than the 10/min auth class (auth.controller.ts), since these are authenticated
 * operator mutations, not anonymous credential attempts. Honored only when rate-limiting is on
 * (THROTTLE_DISABLED unset; disabled in integration tests).
 */
const WRITE_THROTTLE = { default: { limit: 30, ttl: 60_000 } } as const;

@ApiTags('customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customers.read')
  @ApiQuery({ name: 'page[number]', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'page[size]', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiQuery({ name: 'filter[q]', required: false, description: 'Search name / email / wallet number.' })
  @ApiQuery({ name: 'filter[kycStatus]', required: false })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[active]', required: false, description: 'true = ACTIVE, false = not-ACTIVE (used when filter[status] is absent).' })
  @ApiQuery({ name: 'sort', required: false, description: 'Whitelist: createdAt, updatedAt, fullName (prefix "-" = desc).' })
  @ApiQuery(REVEAL_QUERY)
  @ApiOkResponse({ type: PaginatedCustomerListDto, description: 'Masked by default; unmasked only with customers.pii.reveal + ?reveal=true.' })
  list(@Query() query: Record<string, unknown>, @CurrentUser() actor: AuthPrincipal): Promise<PaginatedCustomerListDto> {
    return this.customers.list(query, actor);
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  @ApiQuery(REVEAL_QUERY)
  @ApiOkResponse({ type: CustomerDetailDto, description: 'Masked by default; unmasked only with customers.pii.reveal + ?reveal=true.' })
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('reveal') revealRaw: string | undefined,
    @CurrentUser() actor: AuthPrincipal,
  ): Promise<CustomerDetailDto> {
    return this.customers.getById(id, { reveal: parseReveal(revealRaw), principal: actor });
  }

  @Get(':id/kyc-verifications')
  @RequirePermissions('kyc.read')
  @ApiQuery({ name: 'page[number]', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'page[size]', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiOkResponse({ type: PaginatedKycVerificationListDto, description: 'KYC verification history, newest first.' })
  listKycVerifications(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PaginatedKycVerificationListDto> {
    return this.customers.listKycVerifications(id, query);
  }

  @Get(':id/credential-preview')
  @RequirePermissions('kyc.read')
  @ApiOkResponse({ type: CredentialPreviewDto, description: 'Data-minimized KYC credential preview.' })
  getCredentialPreview(@Param('id', ParseUUIDPipe) id: string): Promise<CredentialPreviewDto> {
    return this.customers.getCredentialPreview(id);
  }

  @Post()
  @RequirePermissions('customers.manage')
  @Throttle(WRITE_THROTTLE)
  // Resource creation returns 201 (Nest's default for @Post); pin it + advertise 201 so the committed
  // OpenAPI spec matches runtime and the generated FE client is not built against a wrong 200 (BE-002).
  @HttpCode(201)
  @ApiCreatedResponse({ type: CustomerDetailDto, description: 'Creates a customer + default wallet; returns masked detail.' })
  create(@Body() dto: CreateCustomerDto, @CurrentUser() actor: AuthPrincipal): Promise<CustomerDetailDto> {
    return this.customers.create(dto, actor);
  }

  @Put(':id')
  // A12/K5 (bugfix-backlog-2026-07): updates re-gated off `customers.manage` onto the dedicated
  // Administrator-only `customers.update` — an operator can CREATE but no longer EDIT (edits load
  // unmasked PII via ?reveal=true, an admin-only capability, so the write gate must match).
  @RequirePermissions('customers.update')
  @Throttle(WRITE_THROTTLE)
  @ApiOkResponse({ type: CustomerDetailDto, description: 'Updates a customer (rowVersion-guarded); returns masked detail. Administrator-only (customers.update).' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() actor: AuthPrincipal,
  ): Promise<CustomerDetailDto> {
    return this.customers.update(id, dto, actor);
  }

  @Delete(':id')
  // Destructive: re-gated off `customers.manage` onto a dedicated `customers.delete` (Admin-only)
  // so create/update-capable roles (e.g. Operator) cannot soft-delete. Separation of duties.
  @RequirePermissions('customers.delete')
  @Throttle(WRITE_THROTTLE)
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthPrincipal): Promise<void> {
    return this.customers.softDelete(id, actor);
  }
}
