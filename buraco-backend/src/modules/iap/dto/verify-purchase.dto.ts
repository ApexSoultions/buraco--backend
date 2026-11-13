import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class VerifyPurchaseDto {
  @ApiProperty({ enum: ['GOOGLE_PLAY', 'APPLE', 'FAKE'], description: 'FAKE is the Unity editor test store (not accepted in production)' })
  @IsIn(['GOOGLE_PLAY', 'APPLE', 'FAKE'])
  store: string;

  @ApiProperty({ example: 'coins_1000' })
  @IsString()
  @MaxLength(100)
  productId: string;

  @ApiPropertyOptional({ description: 'Google Play: the purchase token' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  purchaseToken?: string;

  @ApiPropertyOptional({ description: 'App Store: the StoreKit 2 signed transaction (JWS)' })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  signedTransaction?: string;

  @ApiPropertyOptional({ description: 'Store transaction ID (used for FAKE test purchases)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  transactionId?: string;
}
