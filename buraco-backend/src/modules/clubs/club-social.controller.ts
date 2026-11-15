import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClubsService } from './clubs.service';
import { ClubInvitesService } from './club-invites.service';
import { ClubFeedService } from './club-feed.service';
import { ClubObjectivesService } from './club-objectives.service';
import { requireClubRole } from './club-access';
import { PrismaService } from '../../common/prisma/prisma.service';

class InviteDto {
  @IsUUID()
  userId: string;
}

class AdviceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text: string;
}

/**
 * Clan screens beyond membership (Figma "My Club / Clan view"): invites, the News feed
 * (activities), Advices from the leaders, and the weekly Clan Objectives.
 */
@ApiTags('Clubs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('clubs')
export class ClubSocialController {
  constructor(
    private readonly clubs: ClubsService,
    private readonly invites: ClubInvitesService,
    private readonly feed: ClubFeedService,
    private readonly objectives: ClubObjectivesService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Picture ──────────────────────────────────────────────────────────────

  @Post(':clubId/icon')
  @ApiOperation({ summary: 'Upload the club picture (Leader; JPG/PNG/WebP, max 5 MB)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadIcon(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string, @UploadedFile() file: Express.Multer.File) {
    return this.clubs.uploadIcon(userId, clubId, file);
  }

  // ── Invites ──────────────────────────────────────────────────────────────

  @Get('me/invites')
  @ApiOperation({ summary: 'Club invites waiting for my answer' })
  myInvites(@CurrentUser('id') userId: string) {
    return this.invites.listMine(userId);
  }

  @Put('invites/:inviteId/accept')
  @ApiOperation({ summary: 'Accept a club invite: join the club (also By Request clubs, no points minimum)' })
  @ApiResponse({ status: 400, description: 'ALREADY_IN_CLUB or CLUB_FULL' })
  acceptInvite(@CurrentUser('id') userId: string, @Param('inviteId', new ParseUUIDPipe()) inviteId: string) {
    return this.invites.accept(userId, inviteId);
  }

  @Put('invites/:inviteId/decline')
  @ApiOperation({ summary: 'Decline a club invite' })
  declineInvite(@CurrentUser('id') userId: string, @Param('inviteId', new ParseUUIDPipe()) inviteId: string) {
    return this.invites.decline(userId, inviteId);
  }

  @Post(':clubId/invites')
  @ApiOperation({ summary: 'Invite a player to the club (Leader or Vice Leader)' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 400, description: 'CANNOT_INVITE_SELF, PLAYER_ALREADY_IN_CLUB or CLUB_FULL' })
  @ApiResponse({ status: 409, description: 'INVITE_ALREADY_SENT' })
  invite(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string, @Body() dto: InviteDto) {
    return this.invites.invite(userId, clubId, dto.userId);
  }

  @Get(':clubId/invites')
  @ApiOperation({ summary: 'Invites the club sent that are still unanswered (Leader or Vice Leader)' })
  clubInvites(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string) {
    return this.invites.listForClub(userId, clubId);
  }

  @Delete(':clubId/invites/:inviteId')
  @ApiOperation({ summary: 'Cancel an invite (Leader or Vice Leader)' })
  cancelInvite(
    @CurrentUser('id') userId: string,
    @Param('clubId', new ParseUUIDPipe()) clubId: string,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
  ) {
    return this.invites.cancel(userId, clubId, inviteId);
  }

  @Delete(':clubId/requests')
  @ApiOperation({ summary: '"Clear All" join requests: decline every waiting request (Leader or Vice Leader)' })
  declineAllRequests(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string) {
    return this.clubs.declineAllRequests(userId, clubId);
  }

  // ── News (activities) ────────────────────────────────────────────────────

  @Get(':clubId/activities')
  @ApiOperation({ summary: 'Club News feed, newest first (members)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  activities(
    @CurrentUser('id') userId: string,
    @Param('clubId', new ParseUUIDPipe()) clubId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.feed.listActivities(userId, clubId, Number(page), Number(limit));
  }

  @Delete(':clubId/activities/:activityId')
  @ApiOperation({ summary: 'Delete one News item (Leader or Vice Leader)' })
  deleteActivity(
    @CurrentUser('id') userId: string,
    @Param('clubId', new ParseUUIDPipe()) clubId: string,
    @Param('activityId', new ParseUUIDPipe()) activityId: string,
  ) {
    return this.feed.deleteActivity(userId, clubId, activityId);
  }

  @Delete(':clubId/activities')
  @ApiOperation({ summary: 'Clear the News feed (Leader or Vice Leader)' })
  clearActivities(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string) {
    return this.feed.clearActivities(userId, clubId);
  }

  // ── Advices ──────────────────────────────────────────────────────────────

  @Get(':clubId/advices')
  @ApiOperation({ summary: 'Advices from the club leaders, newest first (members)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  advices(
    @CurrentUser('id') userId: string,
    @Param('clubId', new ParseUUIDPipe()) clubId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.feed.listAdvices(userId, clubId, Number(page), Number(limit));
  }

  @Post(':clubId/advices')
  @ApiOperation({ summary: 'Post an advice to the club (Leader or Vice Leader); members are notified' })
  postAdvice(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string, @Body() dto: AdviceDto) {
    return this.feed.postAdvice(userId, clubId, dto.text);
  }

  @Delete(':clubId/advices/:adviceId')
  @ApiOperation({ summary: 'Delete one advice (Leader or Vice Leader)' })
  deleteAdvice(
    @CurrentUser('id') userId: string,
    @Param('clubId', new ParseUUIDPipe()) clubId: string,
    @Param('adviceId', new ParseUUIDPipe()) adviceId: string,
  ) {
    return this.feed.deleteAdvice(userId, clubId, adviceId);
  }

  @Delete(':clubId/advices')
  @ApiOperation({ summary: 'Clear all advices (Leader or Vice Leader)' })
  clearAdvices(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string) {
    return this.feed.clearAdvices(userId, clubId);
  }

  // ── Clan objectives ──────────────────────────────────────────────────────

  @Get(':clubId/objectives')
  @ApiOperation({ summary: "This week's Clan Objectives with the club's progress (members)" })
  async clubObjectives(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string) {
    await requireClubRole(this.prisma, userId, clubId);
    return this.objectives.list(clubId);
  }
}
