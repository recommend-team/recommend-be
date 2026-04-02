import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

export const updatePayoutSchema = z.object({
  bankName: z.string().min(2, 'Bank name is required').max(100),
  bankCode: z.string().min(1, 'Bank code is required').max(20),
  bankAccountNumber: z
    .string()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
  bankAccountName: z.string().min(2, 'Account name is required').max(100),
});

export type UpdatePayoutDto = z.infer<typeof updatePayoutSchema>;

export class UpdatePayoutRequestDto {
  @ApiProperty({ example: 'Guaranty Trust Bank' })
  bankName: string;

  @ApiProperty({
    example: '058',
    description:
      'Paystack bank code. See https://api.paystack.co/bank for full list.',
  })
  bankCode: string;

  @ApiProperty({
    example: '0123456789',
    description: '10-digit NUBAN account number',
  })
  bankAccountNumber: string;

  @ApiProperty({
    example: 'JOHN ADEBAYO DOE',
    description: 'Account name as it appears at the bank',
  })
  bankAccountName: string;
}
