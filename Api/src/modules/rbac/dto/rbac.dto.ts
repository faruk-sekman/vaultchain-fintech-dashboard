/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contracts for the RBAC admin endpoints. The global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects unknown fields.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ minLength: 2, maxLength: 64 })
  @IsString()
  @Length(2, 64)
  name!: string;
}

export class GrantPermissionDto {
  @ApiProperty({ format: 'uuid', description: 'Permission id from GET /permissions.' })
  @IsUUID()
  permissionId!: string;
}

export class AssignRoleDto {
  @ApiProperty({ format: 'uuid', description: 'Role id from GET /roles.' })
  @IsUUID()
  roleId!: string;
}
