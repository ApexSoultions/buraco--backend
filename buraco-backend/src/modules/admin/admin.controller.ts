import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { CreditUserDto } from './dto/credit-user.dto';
import { BroadcastDto } from './dto/broadcast.dto';
import { CreatePromoDto } from './dto/create-promo.dto';
import { SystemConfigDto } from './dto/system-config.dto';
import { CreateShopItemDto } from './dto/create-shop-item.dto';
import { EditUserDto } from './dto/edit-user.dto';
import { CreateMissionDto } from './dto/create-mission.dto';

@ApiTags('Admin')
@Controller('admin')
@Public()
// The admin panel's server calls every route from one IP, and admin auth runs after the
// global limiter, so the strict signed-out per-IP cap would block a busy dashboard.
// Admin routes keep the per-IP default limit; login keeps the strict one.
@SkipThrottle({ anon: true })
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── Public ───────────────────────────────────────────────────────────────

  @Post('auth/login')
  @Public()
  @SkipThrottle({ anon: false })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Admin login' })
  login(@Body() dto: AdminLoginDto) {
    return this.adminService.login(dto);
  }

  // ─── All admin routes below require admin JWT ─────────────────────────────

  @Get('dashboard')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dashboard statistics' })
  getDashboard() {
    return this.adminService.getDashboard();
  }

  // ─── Users ────────────────────────────────────────────────────────────────

  @Get('users')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List users with pagination and search' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  listUsers(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('search') search?: string,
  ) {
    return this.adminService.listUsers(+page, +limit, search);
  }

  @Get('users/:userId')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user detail with stats, transactions, notes' })
  getUser(@Param('userId') userId: string) {
    return this.adminService.getUser(userId);
  }

  @Patch('users/:userId/ban')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ban or unban a user' })
  banUser(@CurrentUser('id') adminId: string, @Param('userId') userId: string, @Body() dto: BanUserDto) {
    return this.adminService.banUser(adminId, userId, dto);
  }

  @Post('users/:userId/notes')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add admin note to user' })
  addNote(@CurrentUser('id') adminId: string, @Param('userId') userId: string, @Body('content') content: string) {
    return this.adminService.addNote(adminId, userId, content);
  }

  @Post('users/:userId/credit')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Credit coins or diamonds to user' })
  creditUser(@CurrentUser('id') adminId: string, @Param('userId') userId: string, @Body() dto: CreditUserDto) {
    return this.adminService.creditUser(adminId, userId, dto);
  }

  @Post('users/:userId/deduct')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deduct coins or diamonds from user' })
  deductUser(@CurrentUser('id') adminId: string, @Param('userId') userId: string, @Body() dto: CreditUserDto) {
    return this.adminService.deductUser(adminId, userId, dto);
  }

  @Patch('users/:userId')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit user profile fields (username, email, lives, coins, diamonds, subscriptionStatus)' })
  editUser(@CurrentUser('id') adminId: string, @Param('userId') userId: string, @Body() dto: EditUserDto) {
    return this.adminService.editUser(adminId, userId, dto);
  }

  @Post('users/:userId/send-item')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a shop item directly to a user inventory' })
  sendItemToUser(@CurrentUser('id') adminId: string, @Param('userId') userId: string, @Body('itemId') itemId: string) {
    return this.adminService.sendItemToUser(adminId, userId, itemId);
  }

  // ─── Games ────────────────────────────────────────────────────────────────

  @Get('games')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List game sessions' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  listGames(@Query('page') page = 1, @Query('limit') limit = 20, @Query('status') status?: string) {
    return this.adminService.listGames(+page, +limit, status);
  }

  @Patch('games/:gameId/void')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Void a game session' })
  voidGame(@CurrentUser('id') adminId: string, @Param('gameId') gameId: string, @Body('reason') reason: string) {
    return this.adminService.voidGame(adminId, gameId, reason);
  }

  // ─── Shop ─────────────────────────────────────────────────────────────────

  @Get('shop/items')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all shop items' })
  listShopItems(@Query('page') page = 1, @Query('limit') limit = 50) {
    return this.adminService.listShopItems(+page, +limit);
  }

  @Post('shop/items')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create shop item' })
  createShopItem(@CurrentUser('id') adminId: string, @Body() dto: CreateShopItemDto) {
    return this.adminService.createShopItem(adminId, dto);
  }

  @Patch('shop/items/:itemId/toggle')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Activate or deactivate a shop item' })
  toggleShopItem(@CurrentUser('id') adminId: string, @Param('itemId') itemId: string, @Body('isActive') isActive: boolean) {
    return this.adminService.toggleShopItem(adminId, itemId, isActive);
  }

  // ─── Promos ───────────────────────────────────────────────────────────────

  @Post('promos')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create promo code' })
  createPromo(@CurrentUser('id') adminId: string, @Body() dto: CreatePromoDto) {
    return this.adminService.createPromo(adminId, dto);
  }

  @Get('promos')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List promo codes' })
  listPromos(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.adminService.listPromos(+page, +limit);
  }

  @Patch('promos/:promoId/toggle')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Activate or deactivate a promo code' })
  togglePromo(@CurrentUser('id') adminId: string, @Param('promoId') promoId: string, @Body('isActive') isActive: boolean) {
    return this.adminService.togglePromo(adminId, promoId, isActive);
  }

  // ─── Broadcast ────────────────────────────────────────────────────────────

  @Post('broadcast')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send broadcast notification to all users' })
  broadcast(@CurrentUser('id') adminId: string, @Body() dto: BroadcastDto) {
    return this.adminService.broadcast(adminId, dto);
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  @Get('config')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all system config keys' })
  listConfig() {
    return this.adminService.listConfig();
  }

  @Put('config/:key')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set a system config value' })
  setConfig(@CurrentUser('id') adminId: string, @Param('key') key: string, @Body() dto: SystemConfigDto) {
    return this.adminService.setConfig(adminId, key, dto);
  }

  // ─── Clubs ────────────────────────────────────────────────────────────────

  @Get('clubs')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all clubs with pagination and search' })
  @ApiQuery({ name: 'page',   required: false, type: Number })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated club list' })
  listClubs(@Query('page') page = 1, @Query('limit') limit = 20, @Query('search') search?: string) {
    return this.adminService.listClubs(+page, +limit, search);
  }

  @Get('clubs/:clubId')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get club detail with all members' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 200, description: 'Club with members' })
  @ApiResponse({ status: 404, description: 'Club not found' })
  getClub(@Param('clubId') clubId: string) {
    return this.adminService.getClub(clubId);
  }

  @Delete('clubs/:clubId')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a club permanently' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiResponse({ status: 200, description: 'Club deleted' })
  @ApiResponse({ status: 404, description: 'Club not found' })
  deleteClub(@CurrentUser('id') adminId: string, @Param('clubId') clubId: string) {
    return this.adminService.deleteClub(adminId, clubId);
  }

  @Delete('clubs/:clubId/members/:userId')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a member from a club' })
  @ApiParam({ name: 'clubId', description: 'Club UUID' })
  @ApiParam({ name: 'userId', description: 'Member player UUID' })
  @ApiResponse({ status: 200, description: 'Member removed' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  removeClubMember(
    @CurrentUser('id') adminId: string,
    @Param('clubId') clubId: string,
    @Param('userId') userId: string,
  ) {
    return this.adminService.removeClubMember(adminId, clubId, userId);
  }

  // ─── Leaderboard ──────────────────────────────────────────────────────────

  @Get('leaderboard')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get full leaderboard with all player stats' })
  @ApiQuery({ name: 'page',  required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'sort',  required: false, enum: ['points', 'winPercentage', 'gamesPlayed', 'level'] })
  getLeaderboard(
    @Query('page')  page  = 1,
    @Query('limit') limit = 20,
    @Query('sort')  sort  = 'points',
  ) {
    return this.adminService.getLeaderboard(+page, +limit, sort as any);
  }

  @Post('leaderboard/:userId/reset')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reset a player\'s stats to zero' })
  resetPlayerStats(@CurrentUser('id') adminId: string, @Param('userId') userId: string) {
    return this.adminService.resetPlayerStats(adminId, userId);
  }

  @Patch('leaderboard/:userId/score')
  @UseGuards(AdminJwtGuard, AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manually set a player\'s points and/or level' })
  setPlayerScore(
    @CurrentUser('id') adminId: string,
    @Param('userId') userId: string,
    @Body('points') points: number,
    @Body('level')  level?: number,
  ) {
    return this.adminService.setPlayerScore(adminId, userId, points, level);
  }

  // ─── Missions ─────────────────────────────────────────────────────────────

  @Get('missions')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all missions' })
  listMissions() {
    return this.adminService.listMissions();
  }

  @Post('missions')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a mission' })
  createMission(@CurrentUser('id') adminId: string, @Body() dto: CreateMissionDto) {
    return this.adminService.createMission(adminId, dto);
  }

  @Patch('missions/:missionId')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a mission' })
  updateMission(
    @CurrentUser('id') adminId: string,
    @Param('missionId') missionId: string,
    @Body() dto: Partial<CreateMissionDto>,
  ) {
    return this.adminService.updateMission(adminId, missionId, dto);
  }

  @Patch('missions/:missionId/toggle')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle mission active state' })
  toggleMission(
    @CurrentUser('id') adminId: string,
    @Param('missionId') missionId: string,
    @Body('isActive') isActive: boolean,
  ) {
    return this.adminService.toggleMission(adminId, missionId, isActive);
  }

  @Delete('missions/:missionId')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a mission' })
  deleteMission(@CurrentUser('id') adminId: string, @Param('missionId') missionId: string) {
    return this.adminService.deleteMission(adminId, missionId);
  }

  // ─── Audit Logs ───────────────────────────────────────────────────────────

  @Get('audit-logs')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get admin audit logs' })
  getAuditLogs(@Query('page') page = 1, @Query('limit') limit = 50) {
    return this.adminService.getAuditLogs(+page, +limit);
  }
}
