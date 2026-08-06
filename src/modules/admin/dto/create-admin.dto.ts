import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const CreateAdminSchema = z.object({
  firstName: z.string().min(2).max(50),
  lastName: z.string().min(2).max(50),
  email: z.string().email(),
  password: z
    .string()
    .min(8)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain uppercase, lowercase, and a number',
    ),
});

export type CreateAdminDto = z.infer<typeof CreateAdminSchema>;

export class CreateAdminSwaggerDto {
  @ApiProperty({ example: 'Jane' })
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  lastName!: string;

  @ApiProperty({ example: 'jane.doe@recommend.app' })
  email!: string;

  @ApiProperty({ example: 'SecurePass1', minLength: 8 })
  password!: string;
}
