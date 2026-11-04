import { Body, Controller, Delete, Get, Param, ParseEnumPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClubMode, ClubRole, ClubType } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClubsService } from './clubs.service';
import { CreateClubDto } from './dto/create-club.dto';
import { UpdateClubDto } from './dto/update-club.dto';

@ApiTags('Clubs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('clubs')
export class ClubsController {
  constructor(private readonly clubsService: ClubsService) {}

  @Get()
  @ApiOperation({ summary: 'Search and browse clubs' })
  @ApiQuery({ name: 'search', required: false, description: 'Search by club name' })
  @ApiQuery({ name: 'mode',   required: false, enum: ClubMode, description: 'Filter by game mode' })
  @ApiQuery({ name: 'type',   required: false, enum: ClubType, description: 'Filter by join type' })
  @ApiQuery({ name: 'page',   required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit',  required: false, type: Number, description: 'Results per page (default 20)' })
  @ApiResponse({ status: 200, description: 'Paginated club list' })
  searchClubs(
    @Query('search') search?: string,
    @Query('mode') mode?: string,
    @Query('type') type?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.clubsService.searchClubs(search, mode, type, +page, +limit);
  }

  @Get(':clubId')
  @ApiOperation({ summary: 'Get full club detail including members' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 200, description: 'Club detail with members, level progress, and pending requests (leader and vice leaders only)' })
  @ApiResponse({ status: 404, description: 'Club not found' })
  getClub(@Param('clubId') clubId: string, @CurrentUser('id') userId: string) {
    return this.clubsService.getClub(clubId, userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new club' })
  @ApiResponse({ status: 201, description: 'Club created, creator becomes Leader' })
  @ApiResponse({ status: 409, description: 'Club name already taken' })
  createClub(@CurrentUser('id') userId: string, @Body() dto: CreateClubDto) {
    return this.clubsService.createClub(userId, dto);
  }

  @Put(':clubId')
  @ApiOperation({ summary: 'Update club settings (Leader only)' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 200, description: 'Club settings updated' })
  @ApiResponse({ status: 403, description: 'Only the Leader can update club settings' })
  @ApiResponse({ status: 404, description: 'Club not found' })
  updateClub(@CurrentUser('id') userId: string, @Param('clubId') clubId: string, @Body() dto: UpdateClubDto) {
    return this.clubsService.updateClub(userId, clubId, dto);
  }

  @Delete(':clubId')
  @ApiOperation({ summary: 'Delete the club permanently (Leader only)' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 200, description: 'Club deleted' })
  @ApiResponse({ status: 403, description: 'Only the Leader can delete the club' })
  deleteClub(@CurrentUser('id') userId: string, @Param('clubId') clubId: string) {
    return this.clubsService.deleteClub(userId, clubId);
  }

  @Post(':clubId/join')
  @ApiOperation({ summary: 'Instantly join an OPEN club' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 201, description: 'Joined club as Member' })
  @ApiResponse({ status: 400, description: 'Club is full or not open-join type' })
  @ApiResponse({ status: 409, description: 'Already a member' })
  joinClub(@CurrentUser('id') userId: string, @Param('clubId') clubId: string) {
    return this.clubsService.joinClub(userId, clubId);
  }

  @Post(':clubId/request')
  @ApiOperation({ summary: 'Submit a join request to a REQUEST_BASED club' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 201, description: 'Join request submitted' })
  @ApiResponse({ status: 400, description: 'Not a request-based club' })
  @ApiResponse({ status: 409, description: 'Request already pending' })
  requestToJoin(@CurrentUser('id') userId: string, @Param('clubId') clubId: string) {
    return this.clubsService.requestToJoin(userId, clubId);
  }

  @Put(':clubId/requests/:userId/accept')
  @ApiOperation({ summary: 'Accept a join request (Leader or ViceLeader)' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiParam({ name: 'userId', description: 'Requesting player UUID' })
  @ApiResponse({ status: 200, description: 'Request accepted, player is now a Member' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  acceptRequest(@CurrentUser('id') leaderId: string, @Param('clubId') clubId: string, @Param('userId') memberId: string) {
    return this.clubsService.respondToRequest(leaderId, clubId, memberId, true);
  }

  @Put(':clubId/requests/:userId/decline')
  @ApiOperation({ summary: 'Decline a join request (Leader or ViceLeader)' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiParam({ name: 'userId', description: 'Requesting player UUID' })
  @ApiResponse({ status: 200, description: 'Request declined' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  declineRequest(@CurrentUser('id') leaderId: string, @Param('clubId') clubId: string, @Param('userId') memberId: string) {
    return this.clubsService.respondToRequest(leaderId, clubId, memberId, false);
  }

  @Delete(':clubId/members/:userId')
  @ApiOperation({ summary: 'Remove a member from the club (Leader or ViceLeader)' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiParam({ name: 'userId', description: 'Member UUID to remove' })
  @ApiResponse({ status: 200, description: 'Member removed' })
  @ApiResponse({ status: 403, description: 'Insufficient role or cannot remove Leader' })
  removeMember(@CurrentUser('id') leaderId: string, @Param('clubId') clubId: string, @Param('userId') memberId: string) {
    return this.clubsService.removeMember(leaderId, clubId, memberId);
  }

  @Put(':clubId/members/:userId/role')
  @ApiOperation({ summary: 'Assign a role to a member (Leader only)' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiParam({ name: 'userId', description: 'Target member UUID' })
  @ApiBody({ schema: { type: 'object', properties: { role: { type: 'string', enum: Object.values(ClubRole) } }, required: ['role'] } })
  @ApiResponse({ status: 200, description: 'Role updated. Assigning LEADER hands leadership over; the old leader becomes VICE_LEADER.' })
  @ApiResponse({ status: 403, description: 'Only the Leader can assign roles' })
  assignRole(
    @CurrentUser('id') leaderId: string,
    @Param('clubId') clubId: string,
    @Param('userId') memberId: string,
    @Body('role', new ParseEnumPipe(ClubRole)) role: ClubRole,
  ) {
    return this.clubsService.assignRole(leaderId, clubId, memberId, role);
  }

  @Post(':clubId/leave')
  @ApiOperation({ summary: 'Leave the club. Leader must transfer leadership first.' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 200, description: 'Left the club' })
  @ApiResponse({ status: 400, description: 'Leader must transfer leadership before leaving' })
  leaveClub(@CurrentUser('id') userId: string, @Param('clubId') clubId: string) {
    return this.clubsService.leaveClub(userId, clubId);
  }
}
