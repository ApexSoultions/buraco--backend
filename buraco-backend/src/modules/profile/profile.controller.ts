import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation,
  ApiParam, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProfileService, SEARCH_MAX_RESULTS, SEARCH_MIN_CHARS } from './profile.service';
import { SpecialService } from '../special/special.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@ApiTags('Profile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService, private readonly special: SpecialService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get own full profile with stats' })
  @ApiResponse({ status: 200, description: 'Profile returned' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getMyProfile(@CurrentUser('id') userId: string) {
    return this.profileService.getProfile(userId);
  }

  // Declared before ':userId' so "search" is not read as a player id.
  @Get('search')
  @ApiOperation({ summary: 'Search players by username (for "Add new friend")' })
  @ApiQuery({ name: 'q', description: `Part of a username, at least ${SEARCH_MIN_CHARS} characters` })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: `Max results (default and max ${SEARCH_MAX_RESULTS})` })
  @ApiResponse({
    status: 200,
    description: 'Array of { id, username, avatarUrl, level, points, relation, requestId }. relation is FRIEND, '
      + 'REQUEST_SENT, REQUEST_RECEIVED or NONE; requestId is set for the two REQUEST_ values. '
      + 'Blocked players (either way), banned and deleted accounts and yourself are left out.',
  })
  @ApiResponse({ status: 400, description: 'Search text too short or too long' })
  searchPlayers(
    @CurrentUser('id') userId: string,
    @Query('q') query: string,
    @Query('limit') limit?: string,
  ) {
    return this.profileService.searchPlayers(userId, query, limit === undefined ? undefined : Number(limit));
  }

  @Get(':userId')
  @ApiOperation({ summary: "Get another player's public profile" })
  @ApiParam({ name: 'userId', description: 'Target player UUID' })
  @ApiResponse({ status: 200, description: 'Public profile returned' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Player not found' })
  getPublicProfile(@CurrentUser('id') viewerId: string, @Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.profileService.getPublicProfile(userId, viewerId);
  }

  @Put('username')
  @ApiOperation({ summary: 'Change own username (4–20 characters) for the rename price (1,000 coins)' })
  @ApiResponse({ status: 200, description: 'Username updated' })
  @ApiResponse({ status: 400, description: 'Invalid username format' })
  @ApiResponse({ status: 409, description: 'Username already taken' })
  updateUsername(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    // Every rename costs the Special Features "Change Your Name" price.
    return this.special.rename(userId, dto.username!);
  }

  @Post('avatar/upload')
  @ApiOperation({ summary: 'Upload custom avatar image (max 5 MB)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary', description: 'Image file (jpg/png/webp)' } },
      required: ['file'],
    },
  })
  @ApiResponse({ status: 201, description: 'Avatar uploaded, URL returned' })
  @ApiResponse({ status: 400, description: 'File too large or invalid type' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadAvatar(@CurrentUser('id') userId: string, @UploadedFile() file: Express.Multer.File) {
    return this.profileService.uploadAvatar(userId, file);
  }

  @Put('avatar/predefined')
  @ApiOperation({ summary: 'Set a predefined avatar by ID' })
  @ApiBody({ schema: { type: 'object', properties: { predefinedId: { type: 'string' } }, required: ['predefinedId'] } })
  @ApiResponse({ status: 200, description: 'Avatar updated' })
  @ApiResponse({ status: 400, description: 'Invalid predefined avatar ID' })
  setPredefinedAvatar(@CurrentUser('id') userId: string, @Body('predefinedId') predefinedId: string) {
    return this.profileService.setPredefinedAvatar(userId, predefinedId);
  }

  @Get('avatars/predefined')
  @ApiOperation({ summary: 'List all available predefined avatars' })
  @ApiResponse({ status: 200, description: 'Array of predefined avatar options' })
  getPredefinedAvatars() {
    return this.profileService.getPredefinedAvatars();
  }
}
