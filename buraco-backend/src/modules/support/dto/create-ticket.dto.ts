import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTicketDto {
  @ApiProperty({ example: 'Nickname' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;

  @ApiProperty({ example: 'player@example.com', description: 'Where the answer is also sent' })
  @IsEmail()
  @MaxLength(120)
  email: string;

  @ApiProperty({ example: 'I was charged but got no coins.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  message: string;

  @ApiPropertyOptional({ description: 'Optional Instagram / Facebook / X handle' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  social?: string;
}
