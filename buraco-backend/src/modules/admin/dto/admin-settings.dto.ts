import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SettingValueDto {
  @ApiProperty({ description: 'The new value as text. Empty clears a text setting (the server then uses its own).' })
  @IsString()
  @MaxLength(500)
  value: string;
}

export class SendBroadcastDto {
  @ApiProperty({ example: 'New season has started!' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title: string;

  @ApiProperty({ example: 'Play now and climb the ranking.' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  body: string;
}
