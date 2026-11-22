import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Admin passwords: 12+ characters (they can give coins and ban players). */
export const ADMIN_PASSWORD_MIN = 12;

export class ChangeAdminPasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword: string;

  @ApiProperty({ minLength: ADMIN_PASSWORD_MIN })
  @IsString()
  @MinLength(ADMIN_PASSWORD_MIN)
  @MaxLength(128)
  newPassword: string;
}

export class CreateAdminDto {
  @ApiProperty({ example: 'support@warag.app' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Support team' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @ApiProperty({ enum: AdminRole })
  @IsEnum(AdminRole)
  role: AdminRole;

  @ApiProperty({ minLength: ADMIN_PASSWORD_MIN })
  @IsString()
  @MinLength(ADMIN_PASSWORD_MIN)
  @MaxLength(128)
  password: string;
}

export class UpdateAdminDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ enum: AdminRole })
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;

  @ApiPropertyOptional({ description: 'false = the account can no longer log in' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Set a new password for this admin (12+ characters)' })
  @IsOptional()
  @IsString()
  @MinLength(ADMIN_PASSWORD_MIN)
  @MaxLength(128)
  password?: string;
}
