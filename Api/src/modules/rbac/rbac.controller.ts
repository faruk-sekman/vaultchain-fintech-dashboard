/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * RBAC admin endpoints, gated per-route by the relevant `*.manage` /
 * `roles.read` permission. JwtAuthGuard authenticates; PermissionsGuard authorizes; the service
 * adds the self-escalation guard + audit. Responses are wrapped by the global envelope interceptor.
 *
 * `GET /users` is an admin-only paged, PII-minimal user list gated by `users.manage`
 * (NOT `auth.password.admin_reset`: separation of duties — listing operators and resetting a password
 * are distinct capabilities, even though an administrator holds both). It feeds the admin
 * password-reset operator picker (Option 2b).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { AssignRoleDto, CreateRoleDto, GrantPermissionDto } from './dto/rbac.dto';
import { PaginatedUserListDto } from './dto/user-list.dto';
import { RbacService } from './rbac.service';

@ApiTags('rbac')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller()
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('roles')
  @RequirePermissions('roles.read')
  @ApiOkResponse({ description: 'List roles with their permission codes.' })
  listRoles() {
    return this.rbac.listRoles();
  }

  @Post('roles')
  @RequirePermissions('roles.manage')
  @HttpCode(201)
  @ApiCreatedResponse({ description: 'Create a role.' })
  createRole(@Body() dto: CreateRoleDto, @CurrentUser() actor: AuthPrincipal) {
    return this.rbac.createRole(dto.name, actor);
  }

  @Get('permissions')
  @RequirePermissions('roles.read')
  @ApiOkResponse({ description: 'The permission catalog.' })
  listPermissions() {
    return this.rbac.listPermissions();
  }

  @Get('users')
  @RequirePermissions('users.manage')
  @ApiQuery({ name: 'page[number]', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'page[size]', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiQuery({ name: 'filter[q]', required: false, description: 'Search by display name (case-insensitive contains).' })
  @ApiOkResponse({
    type: PaginatedUserListDto,
    description:
      'Admin-only paged user list for the password-reset operator picker + status panel: id, displayName, status, roles, a server-side MASKED email, and lockout telemetry (locked / failedLoginCount / lastLoginAt). No raw PII.',
  })
  listUsers(@Query() query: Record<string, unknown>): Promise<PaginatedUserListDto> {
    return this.rbac.listUsers(query);
  }

  @Post('roles/:roleId/permissions')
  @RequirePermissions('permissions.manage')
  @HttpCode(201)
  @ApiCreatedResponse({ description: 'Grant a permission to a role (self-escalation guarded).' })
  grantPermission(
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: GrantPermissionDto,
    @CurrentUser() actor: AuthPrincipal,
  ) {
    return this.rbac.grantPermission(roleId, dto.permissionId, actor);
  }

  @Delete('roles/:roleId/permissions/:permissionId')
  @RequirePermissions('permissions.manage')
  @HttpCode(204)
  revokePermission(
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Param('permissionId', ParseUUIDPipe) permissionId: string,
    @CurrentUser() actor: AuthPrincipal,
  ): Promise<void> {
    return this.rbac.revokePermission(roleId, permissionId, actor);
  }

  @Post('users/:userId/roles')
  @RequirePermissions('users.manage')
  @HttpCode(201)
  @ApiCreatedResponse({ description: 'Assign a role to a user (self-escalation guarded).' })
  assignRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AssignRoleDto,
    @CurrentUser() actor: AuthPrincipal,
  ) {
    return this.rbac.assignRole(userId, dto.roleId, actor);
  }

  @Delete('users/:userId/roles/:roleId')
  @RequirePermissions('users.manage')
  @HttpCode(204)
  revokeRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() actor: AuthPrincipal,
  ): Promise<void> {
    return this.rbac.revokeRole(userId, roleId, actor);
  }
}
