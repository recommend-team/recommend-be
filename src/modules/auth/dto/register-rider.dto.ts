import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { RiderType } from '../../../common/enums/rider-type.enum';

export const registerRiderSchema = z
  .object({
    email: z.string().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(50, 'Password cannot exceed 50 characters')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
        'Password must contain uppercase, lowercase, number, and special character',
      ),
    firstName: z
      .string()
      .min(2, 'First name must be at least 2 characters')
      .max(50),
    lastName: z
      .string()
      .min(2, 'Last name must be at least 2 characters')
      .max(50),
    phoneNumber: z
      .string()
      .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format'),
    riderType: z.nativeEnum(RiderType, {
      errorMap: () => ({ message: 'riderType must be INDIVIDUAL or COMPANY' }),
    }),
    bvn: z
      .string()
      .regex(/^\d{11}$/, 'BVN must be exactly 11 digits')
      .optional(),
    guarantorName: z.string().min(2).max(100).optional(),
    guarantorPhone: z
      .string()
      .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid guarantor phone number format')
      .optional(),
  })
  .passthrough();

export type RegisterRiderDto = z.infer<typeof registerRiderSchema>;

export class RegisterRiderRequestDto {
  @ApiProperty({ example: 'rider@example.com' })
  email: string;

  @ApiProperty({ example: 'StrongPass123!' })
  password: string;

  @ApiProperty({ example: 'Chukwu' })
  firstName: string;

  @ApiProperty({ example: 'Emeka' })
  lastName: string;

  @ApiProperty({ example: '+2348012345678' })
  phoneNumber: string;

  @ApiProperty({
    enum: RiderType,
    example: RiderType.INDIVIDUAL,
    description: 'INDIVIDUAL = solo rider. COMPANY = logistics company.',
  })
  riderType: RiderType;

  @ApiPropertyOptional({
    example: '12345678901',
    description: 'Bank Verification Number (11 digits)',
  })
  bvn?: string;

  @ApiPropertyOptional({ example: 'Ade Babatunde' })
  guarantorName?: string;

  @ApiPropertyOptional({ example: '+2348087654321' })
  guarantorPhone?: string;

  [k: string]: unknown;
}
