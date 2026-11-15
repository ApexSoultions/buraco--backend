import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GameMode, GameVariant } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RoomsService } from './rooms.service';

@ApiTags('Rooms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Get()
  @ApiOperation({ summary: 'Get lobby room list (4 default tables + custom rooms)' })
  @ApiResponse({ status: 200, description: 'Array of rooms with seatList and seats details' })
  getRooms() {
    return this.roomsService.getRoomList();
  }

  @Get(':roomId')
  @ApiOperation({ summary: 'Get a single room with full player list' })
  @ApiParam({ name: 'roomId', description: 'Room UUID' })
  @ApiResponse({ status: 200, description: 'Room detail' })
  @ApiResponse({ status: 404, description: 'Room not found' })
  getRoom(@Param('roomId') roomId: string) {
    return this.roomsService.getRoom(roomId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new game table (private room)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        mode:          { type: 'string', enum: Object.values(GameMode) },
        variant:       { type: 'string', enum: Object.values(GameVariant) },
        turnDuration:  { type: 'number', description: 'Seconds per turn (default 30)' },
        entryFeeCoins: { type: 'number', description: 'Entry fee in coins (default 0)' },
        minLevel:      { type: 'number', description: 'Minimum player level to join' },
        minPoints:     { type: 'number', description: 'Minimum ranking points to join' },
        endMode:       { type: 'string', enum: ['DIRECT', 'INDIRECT'], description: 'Professional only: end mode' },
        makart:        { type: 'boolean', description: 'Professional only: enable Makart rules' },
        targetScore:   { type: 'number', description: 'Match target score. 0 = One Hand (single round). Positive = play until a team reaches this score (e.g. 100, 500, 2000).' },
        password:      { type: 'string', description: 'Private table (3-20 characters). Others must send it to join; invited friends do not.' },
        textChat:      { type: 'boolean', description: 'Table chat on (default true)' },
        voiceChat:     { type: 'boolean', description: 'Voice clips in table chat (default true)' },
      },
      required: ['mode', 'variant'],
    },
  })
  @ApiResponse({ status: 201, description: 'Room created' })
  @ApiResponse({ status: 400, description: 'Invalid configuration' })
  createRoom(@CurrentUser('id') userId: string, @Body() body: any) {
    return this.roomsService.createRoom(userId, body);
  }

  @Post(':roomId/join')
  @ApiOperation({ summary: 'Join an existing room' })
  @ApiParam({ name: 'roomId', description: 'Room UUID' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        requestedSeatIndex: { type: 'number', enum: [0, 1, 2, 3], description: 'Desired seat (TWO_VS_TWO only). Seat 0 & 2 = team 1, seat 1 & 3 = team 2.' },
        password: { type: 'string', description: 'Needed when the room has hasPassword=true' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Joined room. Response includes seatIndex and teamId. Connect via WebSocket room:join event.' })
  @ApiResponse({ status: 400, description: 'Room full, seat taken, seat selection not supported for 1v1, or requirements not met' })
  @ApiResponse({ status: 403, description: 'PASSWORD_REQUIRED | WRONG_PASSWORD' })
  @ApiResponse({ status: 404, description: 'Room not found' })
  joinRoom(
    @CurrentUser('id') userId: string,
    @Param('roomId') roomId: string,
    @Body() body: { requestedSeatIndex?: number; password?: string },
  ) {
    return this.roomsService.joinRoom(userId, roomId, body?.requestedSeatIndex, { password: body?.password });
  }

  @Post('leave-all-lobby')
  @ApiOperation({ summary: 'Remove authenticated user from all EMPTY/WAITING lobby rooms' })
  @ApiResponse({ status: 200, description: '{ success: true }' })
  leaveAllLobby(@CurrentUser('id') userId: string) {
    return this.roomsService.leaveAllLobby(userId);
  }

  @Post(':roomId/leave')
  @ApiOperation({ summary: 'Leave a room before game starts' })
  @ApiParam({ name: 'roomId', description: 'Room UUID' })
  @ApiResponse({ status: 200, description: 'Left room' })
  @ApiResponse({ status: 404, description: 'Room not found or player not in room' })
  leaveRoom(@CurrentUser('id') userId: string, @Param('roomId') roomId: string) {
    return this.roomsService.leaveRoom(userId, roomId);
  }

  @Post(':roomId/switch-seat')
  @ApiOperation({ summary: 'Switch to a different empty seat in the same room' })
  @ApiParam({ name: 'roomId', description: 'Room UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        requestedSeatIndex: { type: 'number', enum: [0, 1, 2, 3], description: 'Target seat index' },
      },
      required: ['requestedSeatIndex'],
    },
  })
  @ApiResponse({ status: 200, description: 'Seat switched. Response includes updated seatList.' })
  @ApiResponse({ status: 400, description: 'NOT_IN_ROOM | SEAT_TAKEN | INVALID_SEAT_INDEX | ALREADY_IN_SEAT | ROOM_NOT_WAITING' })
  @ApiResponse({ status: 404, description: 'Room not found' })
  switchSeat(
    @CurrentUser('id') userId: string,
    @Param('roomId') roomId: string,
    @Body() body: { requestedSeatIndex: number },
  ) {
    return this.roomsService.switchSeat(userId, roomId, body.requestedSeatIndex);
  }
}
