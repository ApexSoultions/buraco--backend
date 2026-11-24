import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export const MAX_PRICE = 100_000_000;

/** Change a shop item. Send only what changes; `null` for a price removes that price. */
export class UpdateShopItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE)
  priceCoins?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE)
  priceDiamonds?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  sortOrder?: number;
}

/** Change a promo code. The code text itself can't change (players may already have it). */
export class UpdatePromoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE)
  rewardCoins?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE)
  rewardDiamonds?: number;

  @ApiPropertyOptional({ nullable: true, description: 'null = unlimited' })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(1)
  maxUses?: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'null = never expires' })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
