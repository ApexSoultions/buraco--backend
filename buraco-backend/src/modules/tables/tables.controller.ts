import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { v4 as uuidv4 } from 'uuid';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { S3Service } from '../../common/s3/s3.service';
import { TableInvitesService } from './table-invites.service';
import { TABLE_CHAT_MAX_VOICE_SECONDS, TableChatService } from './table-chat.service';
import { RematchService } from './rematch.service';
import { GLOBAL_CHAT_MAX_TEXT, GlobalChatService } from './global-chat.service';

const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/aac', 'audio/x-m4a'];

@ApiTags('Room invites')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('room-invites')
export class RoomInvitesController {
  constructor(private readonly invites: TableInvitesService) {}

  @Post()
  @ApiOperation({ summary: 'Invite a friend to your table (optionally to one chair). The friend gets a room:invite event and a MATCH_INVITE notification; open for 120 s.' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['roomId', 'friendId'],
      properties: {
        roomId:    { type: 'string' },
        friendId:  { type: 'string' },
        seatIndex: { type: 'number', nullable: true, description: 'The chair tapped (0-3); omit for any free chair' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'The invite' })
  @ApiResponse({ status: 400, description: 'ROOM_NOT_WAITING | ROOM_FULL | SEAT_TAKEN | INVALID_SEAT_INDEX | ALREADY_IN_ROOM | INVITE_ALREADY_SENT | CANNOT_INVITE_SELF' })
  @ApiResponse({ status: 403, description: 'NOT_IN_ROOM | NOT_FRIENDS | USER_BLOCKED' })
  send(@CurrentUser('id') userId: string, @Body() body: { roomId: string; friendId: string; seatIndex?: number | null }) {
    return this.invites.sendInvite(userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'My open table invites' })
  mine(@CurrentUser('id') userId: string) {
    return this.invites.getMyInvites(userId);
  }

  @Post(':inviteId/accept')
  @ApiOperation({ summary: 'Accept: sit on the invited chair (or any free one). Same response as POST /rooms/:id/join. The inviter gets room:invite_answer.' })
  @ApiResponse({ status: 404, description: 'INVITE_EXPIRED' })
  accept(@CurrentUser('id') userId: string, @Param('inviteId') inviteId: string) {
    return this.invites.accept(userId, inviteId);
  }

  @Post(':inviteId/decline')
  @ApiOperation({ summary: 'Decline; the inviter gets room:invite_answer { accepted: false }' })
  decline(@CurrentUser('id') userId: string, @Param('inviteId') inviteId: string) {
    return this.invites.decline(userId, inviteId);
  }
}

@ApiTags('Game')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('game')
export class TableSocialController {
  constructor(
    private readonly chat: TableChatService,
    private readonly rematch: RematchService,
    private readonly s3: S3Service,
  ) {}

  // ── Table chat ────────────────────────────────────────────────────────────

  @Get(':gameId/chat')
  @ApiOperation({ summary: 'Table chat: { textChat, voiceChat, messages } (last 50; players of this match only)' })
  @ApiParam({ name: 'gameId' })
  chatHistory(@CurrentUser('id') userId: string, @Param('gameId') gameId: string) {
    return this.chat.history(gameId, userId);
  }

  @Post(':gameId/chat')
  @ApiOperation({ summary: 'Send a table chat message; everyone at the table gets table:chat:message. Same as the socket event table:chat:send.' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['text'],
      properties: {
        kind: { type: 'string', enum: ['TEXT', 'EMOJI', 'QUICK'], description: 'Default TEXT' },
        text: { type: 'string', description: 'Up to 200 characters (40 for EMOJI / QUICK codes)' },
      },
    },
  })
  sendChat(@CurrentUser('id') userId: string, @Param('gameId') gameId: string, @Body() body: { kind?: string; text?: string }) {
    return this.chat.send(gameId, userId, body);
  }

  @Post(':gameId/chat/voice')
  @ApiOperation({ summary: `Send a voice clip to the table (Voice chat subscription; max ${TABLE_CHAT_MAX_VOICE_SECONDS} s, 5 MB). Fields: file, duration.` })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 403, description: 'NOT_AT_TABLE | VOICE_CHAT_REQUIRED' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async sendVoice(
    @CurrentUser('id') userId: string,
    @Param('gameId') gameId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('duration') rawDuration: string,
  ) {
    if (!file) throw new BadRequestException('No audio file provided');
    if (!ALLOWED_AUDIO_TYPES.includes(file.mimetype)) throw new BadRequestException(`Unsupported audio format: ${file.mimetype}`);
    const seconds = parseFloat(rawDuration);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new BadRequestException('duration must be a positive number (seconds)');
    if (seconds > TABLE_CHAT_MAX_VOICE_SECONDS) throw new BadRequestException(`Voice clips can be at most ${TABLE_CHAT_MAX_VOICE_SECONDS} seconds`);

    await this.chat.assertCanSendVoice(gameId, userId);
    const ext = (file.originalname.split('.').pop() ?? 'audio').toLowerCase().replace(/[^a-z0-9]/g, '') || 'audio';
    const key = `voice-messages/table/${gameId}/${uuidv4()}.${ext}`;
    await this.s3.uploadPrivate(key, file.buffer, file.mimetype);
    return this.chat.sendVoice(gameId, userId, key, Math.max(1, Math.round(seconds)));
  }

  @Post(':gameId/chat/report')
  @ApiOperation({ summary: 'Report a player at this table for their chat (saved with their recent table messages)' })
  @ApiBody({ schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' }, reason: { type: 'string', enum: ['SPAM', 'ABUSE', 'INAPPROPRIATE', 'CHEATING', 'OTHER'] } } } })
  reportChat(@CurrentUser('id') userId: string, @Param('gameId') gameId: string, @Body() body: { userId?: string; reason?: string }) {
    return this.chat.report(gameId, userId, body);
  }

  // ── Rematch ───────────────────────────────────────────────────────────────

  @Get(':gameId/rematch')
  @ApiOperation({ summary: 'Rematch state for a finished match' })
  getRematch(@CurrentUser('id') userId: string, @Param('gameId') gameId: string) {
    return this.rematch.get(gameId, userId);
  }

  @Post(':gameId/rematch')
  @ApiOperation({ summary: 'Tap Rematch. When every player has, a new table with the same settings is dealt and game:rematch:start { roomId, newGameId } goes to the old game room.' })
  @ApiResponse({ status: 400, description: 'GAME_NOT_FINISHED | REMATCH_CANCELLED' })
  requestRematch(@CurrentUser('id') userId: string, @Param('gameId') gameId: string) {
    return this.rematch.request(gameId, userId);
  }

  @Post(':gameId/rematch/decline')
  @ApiOperation({ summary: 'Say no (or leave the score board); everyone gets game:rematch:cancelled' })
  declineRematch(@CurrentUser('id') userId: string, @Param('gameId') gameId: string) {
    return this.rematch.decline(gameId, userId);
  }
}

@ApiTags('Global chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('lobby-chat')
export class GlobalChatController {
  constructor(private readonly chat: GlobalChatService) {}

  @Get()
  @ApiOperation({ summary: 'Global Chat on the table list: { messages (last 50, minus cleared / blocked), blockedIds }' })
  history(@CurrentUser('id') userId: string) {
    return this.chat.history(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Send to Global Chat; everyone on the table list (room:subscribe) gets lobby:chat:message' })
  @ApiBody({ schema: { type: 'object', required: ['text'], properties: { kind: { type: 'string', enum: ['TEXT', 'EMOJI'] }, text: { type: 'string', maxLength: GLOBAL_CHAT_MAX_TEXT } } } })
  send(@CurrentUser('id') userId: string, @Body() body: { kind?: string; text?: string }) {
    return this.chat.send(userId, body);
  }

  @Post('clear')
  @ApiOperation({ summary: 'Clear Global Chat for me only' })
  clear(@CurrentUser('id') userId: string) {
    return this.chat.clear(userId);
  }

  @Post('report')
  @ApiOperation({ summary: 'Report a player for their Global Chat messages' })
  report(@CurrentUser('id') userId: string, @Body() body: { userId?: string; reason?: string }) {
    return this.chat.report(userId, body);
  }
}
