import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation,
  ApiParam, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { v4 as uuidv4 } from 'uuid';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { S3Service } from '../../common/s3/s3.service';
import { MAX_VOICE_SECONDS, MessagingService } from './messaging.service';

const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/aac', 'audio/x-m4a'];

@ApiTags('Messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('messaging')
export class MessagingController {
  constructor(
    private readonly messagingService: MessagingService,
    private readonly s3: S3Service,
  ) {}

  @Post('direct/:userId')
  @ApiOperation({ summary: 'Open the 1-to-1 chat with a player (creates it the first time, reuses it after)' })
  @ApiParam({ name: 'userId', description: "The other player's user UUID" })
  @ApiResponse({ status: 201, description: 'Conversation in the same shape as GET /conversations rows' })
  @ApiResponse({ status: 400, description: 'Tried to chat with yourself' })
  @ApiResponse({ status: 403, description: 'USER_BLOCKED — one of you has blocked the other' })
  @ApiResponse({ status: 404, description: 'User not found' })
  startDirect(
    @CurrentUser('id') userId: string,
    @Param('userId', new ParseUUIDPipe()) otherUserId: string,
  ) {
    return this.messagingService.startDirectConversation(userId, otherUserId);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Get all conversations (direct + club) for current user' })
  @ApiResponse({ status: 200, description: 'Array of conversations with last message preview' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getConversations(@CurrentUser('id') userId: string) {
    return this.messagingService.getConversations(userId);
  }

  @Get('conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Get paginated message history for a conversation' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiQuery({ name: 'page',  required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Messages per page (default 50)' })
  @ApiResponse({ status: 200, description: 'Paginated messages array' })
  @ApiResponse({ status: 403, description: 'Not a member of this conversation' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  getHistory(
    @Param('conversationId') conversationId: string,
    @CurrentUser('id') userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
  ) {
    return this.messagingService.getHistory(conversationId, userId, +page, +limit);
  }

  @Post('conversations/:conversationId/voice')
  @ApiOperation({ summary: 'Upload a voice message (multipart/form-data, max 5 MB). Fields: file (audio), duration (seconds).' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'duration'],
      properties: {
        file:     { type: 'string', format: 'binary', description: 'Audio file (mp3, m4a, webm, ogg, wav, aac)' },
        duration: { type: 'number', description: 'Recording duration in seconds' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Voice message sent; also emitted on chat:message WS event. voiceUrl is a signed link valid for 1 hour.' })
  @ApiResponse({ status: 400, description: 'Missing file, unsupported audio format, or invalid duration' })
  @ApiResponse({ status: 403, description: 'Not a member of this conversation, or USER_BLOCKED' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async sendVoiceMessage(
    @Param('conversationId') conversationId: string,
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('duration') rawDuration: string,
  ) {
    if (!file) throw new BadRequestException('No audio file provided');
    if (!ALLOWED_AUDIO_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(`Unsupported audio format: ${file.mimetype}`);
    }

    const seconds = parseFloat(rawDuration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new BadRequestException('duration must be a positive number (seconds)');
    }
    if (seconds > MAX_VOICE_SECONDS) {
      throw new BadRequestException(`Voice messages can be at most ${MAX_VOICE_SECONDS} seconds`);
    }
    // Message.duration is an Int column — a fractional value like 3.4 would fail the insert.
    const duration = Math.max(1, Math.round(seconds));

    // Check membership before anything is uploaded, so strangers cannot fill the bucket.
    const memberIds = await this.messagingService.assertCanSend(conversationId, userId);

    const ext = (file.originalname.split('.').pop() ?? 'audio').toLowerCase().replace(/[^a-z0-9]/g, '') || 'audio';
    const key = `voice-messages/${conversationId}/${uuidv4()}.${ext}`;
    // Private object: members get a short-lived signed link, never a permanent public URL.
    await this.s3.uploadPrivate(key, file.buffer, file.mimetype);

    // Saves the message and delivers chat:message to every member over WebSocket.
    return this.messagingService.sendVoiceMessage(conversationId, userId, key, duration, memberIds);
  }

  @Put('conversations/:conversationId/read')
  @ApiOperation({ summary: 'Mark all messages in a conversation as read' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'All messages marked as read' })
  @ApiResponse({ status: 403, description: 'Not a member of this conversation' })
  markAsRead(@Param('conversationId') conversationId: string, @CurrentUser('id') userId: string) {
    return this.messagingService.markAsRead(conversationId, userId);
  }
}
