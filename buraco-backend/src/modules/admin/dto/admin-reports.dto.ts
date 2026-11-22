import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ReportStatusDto {
  @ApiProperty({ enum: ReportStatus, description: 'REVIEWED = handled, DISMISSED = nothing wrong, OPEN = reopen' })
  @IsEnum(ReportStatus)
  status: ReportStatus;

  @ApiPropertyOptional({ description: 'Short note on what was done' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  resolution?: string;
}

export class BanFromReportDto {
  @ApiProperty({ example: 'Abusive chat' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason: string;
}

export class RemoveGlobalChatDto {
  @ApiPropertyOptional({ description: 'Remove this one message' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  messageId?: string;

  @ApiPropertyOptional({ description: 'Remove every message of this player' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
