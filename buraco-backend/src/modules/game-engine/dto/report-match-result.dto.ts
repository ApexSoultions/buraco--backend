import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * Reasons the acting host may report. Anything else is normalised to `finished`
 * (see GameEngineService.normalizeReason) rather than rejected — a match that
 * really did end must never fail to persist over an unrecognised label.
 */
export const MATCH_END_REASONS = [
  'finished',
  'left',
  'abandoned',
  'inactive',
  'Buraco of 2',
  'connection_lost',
] as const;

/**
 * One player's end-of-match scoreboard row, exactly as the Unity client serialises it
 * (JsonUtility emits every field, so all of these arrive on a normal report). Everything
 * except `playerId` is optional so a partial body still persists instead of 400ing —
 * this endpoint is fire-and-forget from the client's perspective.
 *
 * `potNotTaken` and `paidCards` arrive as signed negatives; `matchScore` is the
 * cumulative match total and `roundScore` the final round's total.
 */
export class ReportMatchPlayerDto {
  @ApiProperty()
  @IsString()
  playerId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  playerName?: string;

  @ApiPropertyOptional({ enum: ['WIN', 'LOSS', 'DRAW'] })
  @IsOptional()
  @IsString()
  result?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  boardScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  cleanBuraco?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  semiCleanBuraco?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  dirtyBuraco?: number;

  @ApiPropertyOptional({ description: 'Signed negative penalty' })
  @IsOptional()
  @IsInt()
  potNotTaken?: number;

  @ApiPropertyOptional({ description: 'Signed negative penalty' })
  @IsOptional()
  @IsInt()
  paidCards?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  finishBonus?: number;

  @ApiPropertyOptional({ description: 'Cumulative match total' })
  @IsOptional()
  @IsInt()
  matchScore?: number;

  @ApiPropertyOptional({ description: 'Final round total' })
  @IsOptional()
  @IsInt()
  roundScore?: number;
}

/**
 * Body of POST /v1/game/:gameId/report-result — the final outcome of a Photon Fusion
 * match as computed by the acting host device (see MatchResultReport in schema.prisma).
 */
export class ReportMatchResultDto {
  @ApiPropertyOptional({ description: 'Echo of the path param; the path is authoritative' })
  @IsOptional()
  @IsString()
  gameId?: string;

  @ApiPropertyOptional({ description: '1 or 2; 0 when unknown or a draw' })
  @IsOptional()
  @IsInt()
  winnerTeam?: number;

  @ApiPropertyOptional({ description: 'userIds of the winning side; empty on a neutral end' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  winnerIds?: string[];

  @ApiPropertyOptional({ enum: MATCH_END_REASONS })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiProperty({ type: [ReportMatchPlayerDto] })
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ReportMatchPlayerDto)
  players: ReportMatchPlayerDto[];
}
