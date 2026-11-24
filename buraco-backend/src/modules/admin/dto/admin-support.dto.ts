import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class SupportReplyDto {
  @ApiProperty({ example: 'Thanks for telling us. We added the coins to your account.' })
  @IsString()
  @MinLength(2)
  @MaxLength(1500)
  message: string;
}

export class SupportStatusDto {
  @ApiProperty({ enum: ['OPEN', 'CLOSED'], description: 'CLOSED = done; OPEN = reopen' })
  @IsIn(['OPEN', 'CLOSED'])
  status: 'OPEN' | 'CLOSED';
}
