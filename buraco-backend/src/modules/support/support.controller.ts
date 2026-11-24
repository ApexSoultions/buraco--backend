import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { SupportService } from './support.service';

@ApiTags('Support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post('tickets')
  @ApiOperation({ summary: 'Send a message to the game staff (max 3 per day)' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateTicketDto) {
    return this.support.create(userId, dto);
  }

  @Get('tickets')
  @ApiOperation({ summary: 'My messages to support with the answers' })
  mine(@CurrentUser('id') userId: string) {
    return this.support.mine(userId);
  }
}
