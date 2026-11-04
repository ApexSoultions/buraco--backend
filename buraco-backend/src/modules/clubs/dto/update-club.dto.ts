import { PartialType } from '@nestjs/swagger';
import { CreateClubDto } from './create-club.dto';

// The update endpoint used to take `Partial<CreateClubDto>`, a type that disappears at
// runtime, so the body skipped validation entirely and a leader could set points, level or
// memberCount directly. This class keeps the same optional fields and is validated.
export class UpdateClubDto extends PartialType(CreateClubDto) {}
