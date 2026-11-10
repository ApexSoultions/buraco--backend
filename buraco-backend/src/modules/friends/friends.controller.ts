import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FriendsService } from './friends.service';

@ApiTags('Friends')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('friends')
export class FriendsController {
  constructor(private readonly friendsService: FriendsService) {}

  @Get()
  @ApiOperation({ summary: 'Get own friend list' })
  @ApiResponse({ status: 200, description: 'Array of friends with profile info' })
  getFriends(@CurrentUser('id') userId: string) {
    return this.friendsService.getFriends(userId);
  }

  @Get('requests/incoming')
  @ApiOperation({ summary: 'Get incoming (pending) friend requests' })
  @ApiResponse({ status: 200, description: 'Array of pending incoming requests' })
  getPendingRequests(@CurrentUser('id') userId: string) {
    return this.friendsService.getPendingRequests(userId);
  }

  @Get('requests/sent')
  @ApiOperation({ summary: 'Get sent friend requests awaiting response' })
  @ApiResponse({ status: 200, description: 'Array of sent requests' })
  getSentRequests(@CurrentUser('id') userId: string) {
    return this.friendsService.getSentRequests(userId);
  }

  @Get('blocked')
  @ApiOperation({ summary: 'Get list of blocked users' })
  @ApiResponse({ status: 200, description: 'Array of blocked user profiles' })
  getBlockedUsers(@CurrentUser('id') userId: string) {
    return this.friendsService.getBlockedUsers(userId);
  }

  @Post('request')
  @ApiOperation({ summary: 'Send a friend request to another player' })
  @ApiBody({ schema: { type: 'object', properties: { userId: { type: 'string', description: 'Target player UUID' } }, required: ['userId'] } })
  @ApiResponse({ status: 201, description: 'Request sent' })
  @ApiResponse({ status: 400, description: 'Already friends or request pending' })
  @ApiResponse({ status: 404, description: 'Target player not found' })
  sendRequest(@CurrentUser('id') userId: string, @Body('userId', new ParseUUIDPipe()) targetId: string) {
    return this.friendsService.sendRequest(userId, targetId);
  }

  @Put('request/:requestId/accept')
  @ApiOperation({ summary: 'Accept an incoming friend request' })
  @ApiParam({ name: 'requestId', description: 'Friendship request UUID' })
  @ApiResponse({ status: 200, description: 'Request accepted, now friends' })
  @ApiResponse({ status: 403, description: 'Not your request to accept' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  acceptRequest(@CurrentUser('id') userId: string, @Param('requestId') requestId: string) {
    return this.friendsService.acceptRequest(userId, requestId);
  }

  @Put('request/:requestId/decline')
  @ApiOperation({ summary: 'Decline an incoming friend request' })
  @ApiParam({ name: 'requestId', description: 'Friendship request UUID' })
  @ApiResponse({ status: 200, description: 'Request declined' })
  @ApiResponse({ status: 403, description: 'Not your request to decline' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  declineRequest(@CurrentUser('id') userId: string, @Param('requestId') requestId: string) {
    return this.friendsService.declineRequest(userId, requestId);
  }

  @Delete(':friendId')
  @ApiOperation({ summary: 'Remove a friend' })
  @ApiParam({ name: 'friendId', description: 'Friend player UUID' })
  @ApiResponse({ status: 200, description: 'Friend removed' })
  @ApiResponse({ status: 404, description: 'Friendship not found' })
  removeFriend(@CurrentUser('id') userId: string, @Param('friendId') friendId: string) {
    return this.friendsService.removeFriend(userId, friendId);
  }

  @Post('block')
  @ApiOperation({ summary: 'Block a player — hides them from all interactions' })
  @ApiBody({ schema: { type: 'object', properties: { userId: { type: 'string', description: 'Player UUID to block' } }, required: ['userId'] } })
  @ApiResponse({ status: 201, description: 'User blocked' })
  @ApiResponse({ status: 404, description: 'Target player not found' })
  blockUser(@CurrentUser('id') userId: string, @Body('userId', new ParseUUIDPipe()) targetId: string) {
    return this.friendsService.blockUser(userId, targetId);
  }

  @Delete('block/:userId')
  @ApiOperation({ summary: 'Unblock a previously blocked player' })
  @ApiParam({ name: 'userId', description: 'Player UUID to unblock' })
  @ApiResponse({ status: 200, description: 'User unblocked' })
  @ApiResponse({ status: 404, description: 'Block record not found' })
  unblockUser(@CurrentUser('id') userId: string, @Param('userId') targetId: string) {
    return this.friendsService.unblockUser(userId, targetId);
  }
}
