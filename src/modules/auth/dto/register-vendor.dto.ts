import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { VendorType } from '../../../common/enums/vendor-type.enum';

export const registerVendorSchema = z.object({
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
  vendorType: z.nativeEnum(VendorType, {
    errorMap: () => ({
      message: 'vendorType must be REGISTERED or NON_REGISTERED',
    }),
  }),
  businessName: z
    .string()
    .min(2, 'Business name must be at least 2 characters')
    .max(100),
  businessAddress: z
    .string()
    .min(5, 'Business address must be at least 5 characters')
    .max(255),
  businessCategory: z.string().min(2, 'Business category is required').max(100),
  businessDescription: z.string().max(500).optional(),
});

export type RegisterVendorDto = z.infer<typeof registerVendorSchema>;

export class RegisterVendorRequestDto {
  @ApiProperty({ example: 'vendor@example.com' })
  email!: string;

  @ApiProperty({ example: 'StrongPass123!' })
  password!: string;

  @ApiProperty({ example: 'John' })
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  lastName!: string;

  @ApiProperty({ example: '+2348012345678' })
  phoneNumber!: string;

  @ApiProperty({
    enum: VendorType,
    example: VendorType.REGISTERED,
    description:
      'REGISTERED = has CAC/TIN (unlimited orders, verified badge). NON_REGISTERED = informal vendor (20 orders/month cap).',
  })
  vendorType!: VendorType;

  @ApiProperty({ example: "Mama's Kitchen" })
  businessName!: string;

  @ApiProperty({ example: '12 Broad Street, Lagos Island' })
  businessAddress!: string;

  @ApiProperty({ example: 'Restaurant' })
  businessCategory!: string;

  @ApiPropertyOptional({ example: 'Authentic Nigerian cuisine' })
  businessDescription?: string;
}
