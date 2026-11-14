import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SpecialService } from './special.service';
import { CustomCardsService } from './custom-cards.service';

class NameDto {
  @IsString()
  @MaxLength(30)
  name: string;
}

@ApiTags('Special features')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('special')
export class SpecialController {
  constructor(
    private readonly special: SpecialService,
    private readonly customCards: CustomCardsService,
  ) {}

  @Get('features')
  @ApiOperation({ summary: 'Prices, black list size and the player\'s club seats (Special Features page)' })
  features(@CurrentUser('id') userId: string) {
    return this.special.features(userId);
  }

  @Get('names')
  @ApiOperation({ summary: 'Short names (1–3 characters) starting with prefix, and whether each can be bought' })
  @ApiQuery({ name: 'length', enum: [1, 2, 3] })
  @ApiQuery({ name: 'prefix', required: false })
  names(@Query('length') length: string, @Query('prefix') prefix?: string) {
    return this.special.listShortNames(Number(length), prefix);
  }

  @Post('names/buy')
  @ApiOperation({ summary: 'Buy a 1–3 character username (70,000 / 7,000 / 1,000 coins)' })
  @ApiResponse({ status: 400, description: 'INVALID_NAME or INSUFFICIENT_BALANCE' })
  @ApiResponse({ status: 409, description: 'USERNAME_TAKEN' })
  buyName(@CurrentUser('id') userId: string, @Body() dto: NameDto) {
    return this.special.buyShortName(userId, dto.name);
  }

  @Post('rename')
  @ApiOperation({ summary: 'Change Your Name: a 4–20 character username, for the rename price' })
  rename(@CurrentUser('id') userId: string, @Body() dto: NameDto) {
    return this.special.rename(userId, dto.name);
  }

  @Post('clubs/:clubId/name')
  @ApiOperation({ summary: 'Change Club Name (club leader)' })
  renameClub(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string, @Body() dto: NameDto) {
    return this.special.renameClub(userId, clubId, dto.name);
  }

  @Post('clubs/:clubId/seats')
  @ApiOperation({ summary: '+10 Clan Member (club leader)' })
  addSeats(@CurrentUser('id') userId: string, @Param('clubId', new ParseUUIDPipe()) clubId: string) {
    return this.special.addClubSeats(userId, clubId);
  }

  @Post('block-slots')
  @ApiOperation({ summary: '+10 Black List' })
  addBlockSlots(@CurrentUser('id') userId: string) {
    return this.special.addBlockSlots(userId);
  }

  // ── Custom Cards ─────────────────────────────────────────────────────────

  @Get('custom-cards')
  @ApiOperation({ summary: 'My custom cards (PENDING / APPROVED / REJECTED), each with a 1-hour picture link' })
  myCustomCards(@CurrentUser('id') userId: string) {
    return this.customCards.listMine(userId);
  }

  @Post('custom-cards')
  @ApiOperation({ summary: 'Send a picture as a custom card back (40,000 coins; refunded if rejected). Waits for admin review.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary', description: 'JPG, PNG or WebP, max 5 MB' } } } })
  @ApiResponse({ status: 400, description: 'INSUFFICIENT_BALANCE or bad picture' })
  @ApiResponse({ status: 409, description: 'CUSTOM_CARD_PENDING_LIMIT (3 waiting for review)' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  createCustomCard(@CurrentUser('id') userId: string, @UploadedFile() file: Express.Multer.File) {
    return this.customCards.create(userId, file);
  }

  @Put('custom-cards/:id/equip')
  @ApiOperation({ summary: 'Use an approved custom card as my card back' })
  equipCustomCard(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.customCards.equip(userId, id);
  }
}
