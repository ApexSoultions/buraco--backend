import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MoveType } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GameEngineService } from './game-engine.service';
import { ReportMatchResultDto } from './dto/report-match-result.dto';

@ApiTags('Game')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('game')
export class GameEngineController {
  constructor(private readonly gameEngineService: GameEngineService) {}

  @Get(':gameId/state')
  @ApiOperation({ summary: 'Get current game state (filtered to your view)' })
  getState(@Param('gameId') gameId: string, @CurrentUser('id') userId: string) {
    return this.gameEngineService.getGameState(gameId, userId);
  }

  @Get(':gameId/result')
  @ApiOperation({ summary: 'Get final match result and per-player scores' })
  getResult(@Param('gameId') gameId: string) {
    return this.gameEngineService.getGameResult(gameId);
  }

  @Post(':gameId/report-result')
  @ApiOperation({
    summary: 'Report the final result of a Photon Fusion match (acting host device)',
    description:
      'Idempotent per gameId — retries and a second report after host migration both return { ok: true } ' +
      'without overwriting the stored result.',
  })
  @ApiBody({ type: ReportMatchResultDto })
  // The body is taken raw (typed as a plain object) so the global ValidationPipe's
  // `forbidNonWhitelisted` does not reject it: the service validates it itself, stripping
  // unknown properties instead of 400ing on them. A client that starts sending one extra
  // field must not silently lose the ability to persist a finished match.
  reportResult(
    @Param('gameId') gameId: string,
    @CurrentUser('id') userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.gameEngineService.reportMatchResult(gameId, userId, body);
  }

  @Post(':gameId/move/draw')
  @ApiOperation({ summary: 'Draw a card from stock or discard pile' })
  draw(@Param('gameId') gameId: string, @CurrentUser('id') userId: string, @Body('source') source: 'STOCK' | 'DISCARD') {
    const type = source === 'DISCARD' ? MoveType.DRAW_DISCARD : MoveType.DRAW_STOCK;
    return this.gameEngineService.processMove(gameId, userId, { type, source });
  }

  @Post(':gameId/move/meld')
  @ApiOperation({ summary: 'Play a meld from hand' })
  playMeld(@Param('gameId') gameId: string, @CurrentUser('id') userId: string, @Body() body: { cardIds: string[] }) {
    return this.gameEngineService.processMove(gameId, userId, { type: MoveType.PLAY_MELD, cardIds: body.cardIds });
  }

  @Post(':gameId/move/add-to-meld')
  @ApiOperation({ summary: 'Add cards to an existing meld' })
  addToMeld(@Param('gameId') gameId: string, @CurrentUser('id') userId: string, @Body() body: { meldId: string; cardIds: string[] }) {
    return this.gameEngineService.processMove(gameId, userId, { type: MoveType.ADD_TO_MELD, meldId: body.meldId, cardIds: body.cardIds });
  }

  @Post(':gameId/move/discard')
  @ApiOperation({ summary: 'Discard a card to end your turn' })
  discard(@Param('gameId') gameId: string, @CurrentUser('id') userId: string, @Body('cardId') cardId: string) {
    return this.gameEngineService.processMove(gameId, userId, { type: MoveType.DISCARD, cardIds: [cardId] });
  }

  @Post(':gameId/move/pickup-pot')
  @ApiOperation({ summary: 'Pick up the pot pile' })
  pickupPot(@Param('gameId') gameId: string, @CurrentUser('id') userId: string) {
    return this.gameEngineService.processMove(gameId, userId, { type: MoveType.PICKUP_POT });
  }
}
