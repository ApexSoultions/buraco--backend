import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Why the staff member did it. Shown to the player in the notification. */
export class ReasonDto {
  @ApiPropertyOptional({ example: 'Offensive name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class MakeLeaderDto {
  @ApiProperty({ description: 'An active member who becomes the leader (the old leader becomes vice leader)' })
  @IsUUID()
  userId: string;
}
