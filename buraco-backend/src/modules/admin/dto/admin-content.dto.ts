import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { GameMode, MissionRequirement } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

const MAX_REWARD = 100_000_000;

/** A lifetime goal for one player ("Win 10 games → 1,000 coins"), claimed once. */
export class CreateAchievementDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80)
  title: string;

  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200)
  description: string;

  @ApiProperty({ enum: MissionRequirement }) @IsEnum(MissionRequirement)
  requirement: MissionRequirement;

  @ApiProperty() @IsInt() @Min(1) @Max(MAX_REWARD)
  targetValue: number;

  @ApiPropertyOptional({ enum: GameMode, nullable: true, description: 'null = any mode' })
  @ValidateIf((_, v) => v !== null && v !== undefined) @IsEnum(GameMode)
  mode?: GameMode | null;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_REWARD)
  rewardCoins?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_REWARD)
  rewardDiamonds?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100_000)
  sortOrder?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isActive?: boolean;
}
export class UpdateAchievementDto extends PartialType(CreateAchievementDto) {}

/** A weekly goal for a whole clan; completing it pays every active member and adds club points. */
export class CreateClubObjectiveDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80)
  title: string;

  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200)
  description: string;

  @ApiProperty({ enum: MissionRequirement }) @IsEnum(MissionRequirement)
  requirement: MissionRequirement;

  @ApiProperty() @IsInt() @Min(1) @Max(MAX_REWARD)
  targetValue: number;

  @ApiPropertyOptional({ enum: GameMode, nullable: true, description: 'null = any mode' })
  @ValidateIf((_, v) => v !== null && v !== undefined) @IsEnum(GameMode)
  mode?: GameMode | null;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_REWARD)
  rewardCoins?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_REWARD)
  rewardClubPoints?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100_000)
  sortOrder?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isActive?: boolean;
}
export class UpdateClubObjectiveDto extends PartialType(CreateClubObjectiveDto) {}
