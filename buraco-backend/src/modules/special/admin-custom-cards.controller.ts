import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole, CustomCardStatus } from '@prisma/client';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CustomCardsService } from './custom-cards.service';

class RejectDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** Review players' custom card pictures (admin panel / Swagger with an admin token). */
@ApiTags('Admin: custom cards')
@ApiBearerAuth()
@Public() // not the player login: the admin guard below checks the admin token
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
@Controller('admin/custom-cards')
export class AdminCustomCardsController {
  constructor(private readonly customCards: CustomCardsService) {}

  @Get()
  @ApiOperation({ summary: 'Custom cards to review (default PENDING), oldest first, with picture links' })
  @ApiQuery({ name: 'status', required: false, enum: CustomCardStatus })
  list(@Query('status') status?: CustomCardStatus) {
    return this.customCards.listForReview(status && status in CustomCardStatus ? status : CustomCardStatus.PENDING);
  }

  @Put(':id/approve')
  @ApiOperation({ summary: 'Approve: the player can now use this card back' })
  approve(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser('id') adminId: string) {
    return this.customCards.approve(id, adminId);
  }

  @Put(':id/reject')
  @ApiOperation({ summary: 'Reject and refund the player' })
  reject(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser('id') adminId: string, @Body() dto: RejectDto) {
    return this.customCards.reject(id, adminId, dto?.reason);
  }
}
