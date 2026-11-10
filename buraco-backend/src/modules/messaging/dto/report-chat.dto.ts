import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const MAX_REPORT_DETAILS = 500;

export class ReportChatDto {
  @ApiProperty({ enum: ReportReason })
  @IsEnum(ReportReason)
  reason: ReportReason;

  @ApiPropertyOptional({
    description: 'The message being reported. Required in a club chat; optional in a 1-to-1 chat '
      + '(without it, the other player is reported).',
  })
  @IsOptional()
  @IsUUID()
  messageId?: string;

  @ApiPropertyOptional({ maxLength: MAX_REPORT_DETAILS })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REPORT_DETAILS)
  details?: string;
}
