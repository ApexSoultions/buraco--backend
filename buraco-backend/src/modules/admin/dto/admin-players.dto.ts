import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class AdjustLivesDto {
  @ApiProperty({ description: 'Lives to give (positive) or take (negative)', example: 5 })
  @IsInt()
  @Min(-1000)
  @Max(1000)
  amount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
