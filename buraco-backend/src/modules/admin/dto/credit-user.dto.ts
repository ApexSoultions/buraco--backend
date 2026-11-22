import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrencyType } from '@prisma/client';

/** Largest single change, so a typo (an extra zero) can't hand out billions. */
export const MAX_BALANCE_CHANGE = 10_000_000;

export class CreditUserDto {
  @ApiProperty({ enum: CurrencyType })
  @IsEnum(CurrencyType)
  currency: CurrencyType;

  @ApiProperty({ minimum: 1, maximum: MAX_BALANCE_CHANGE })
  @IsInt()
  @Min(1)
  @Max(MAX_BALANCE_CHANGE)
  amount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
