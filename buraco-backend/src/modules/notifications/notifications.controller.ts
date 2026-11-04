import { Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get paginated notification list' })
  @ApiQuery({ name: 'page',       required: false, type: Number,  description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit',      required: false, type: Number,  description: 'Per page (default 20)' })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean, description: 'Return only unread notifications' })
  @ApiResponse({ status: 200, description: 'Paginated notification list' })
  getNotifications(
    @CurrentUser('id') userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('unreadOnly') unreadOnly: string | boolean = false,
  ) {
    // Query strings arrive as text: Boolean('false') would be true.
    return this.notificationsService.getNotifications(userId, +page, +limit, unreadOnly === true || unreadOnly === 'true');
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get total unread notification count' })
  @ApiResponse({ status: 200, description: '{ count: number }' })
  getUnreadCount(@CurrentUser('id') userId: string) {
    return this.notificationsService.getUnreadCount(userId);
  }

  @Put(':notificationId/read')
  @ApiOperation({ summary: 'Mark a single notification as read' })
  @ApiParam({ name: 'notificationId', description: 'Notification UUID' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  markAsRead(@CurrentUser('id') userId: string, @Param('notificationId') id: string) {
    return this.notificationsService.markAsRead(userId, id);
  }

  @Put('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  markAllAsRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllAsRead(userId);
  }

  @Delete(':notificationId')
  @ApiOperation({ summary: 'Delete a notification' })
  @ApiParam({ name: 'notificationId', description: 'Notification UUID' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  delete(@CurrentUser('id') userId: string, @Param('notificationId') id: string) {
    return this.notificationsService.delete(userId, id);
  }
}
