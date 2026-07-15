import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MoveType } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GameEngineService } from './game-engine.service';

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
