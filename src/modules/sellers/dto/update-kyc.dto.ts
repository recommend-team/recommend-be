import { ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const urlField = z.string().url('Must be a valid URL');

/** Accepted for REGISTERED vendors (CAC/TIN) */
export const updateRegisteredKycSchema = z
  .object({
    cacDocumentUrl: urlField.optional(),
    tinDocumentUrl: urlField.optional(),
  })
  .refine(
    (d) => d.cacDocumentUrl !== undefined || d.tinDocumentUrl !== undefined,
    { message: 'At least one KYC document URL must be provided' },
  );

/** Accepted for NON_REGISTERED vendors */
export const updateNonRegisteredKycSchema = z
  .object({
    ninDocumentUrl: urlField.optional(),
    passportPhotoUrl: urlField.optional(),
    bankStatementUrl: urlField.optional(),
    utilityBillUrl: urlField.optional(),
  })
  .refine(
    (d) =>
      d.ninDocumentUrl !== undefined ||
      d.passportPhotoUrl !== undefined ||
      d.bankStatementUrl !== undefined ||
      d.utilityBillUrl !== undefined,
    { message: 'At least one KYC document URL must be provided' },
  );

export type UpdateRegisteredKycDto = z.infer<typeof updateRegisteredKycSchema>;
export type UpdateNonRegisteredKycDto = z.infer<
  typeof updateNonRegisteredKycSchema
>;

export class UpdateKycRequestDto {
  @ApiPropertyOptional({
    description: 'CAC certificate URL — REGISTERED vendors only',
    example: 'https://res.cloudinary.com/example/cac.pdf',
  })
  cacDocumentUrl?: string;

  @ApiPropertyOptional({
    description: 'TIN certificate URL — REGISTERED vendors only',
    example: 'https://res.cloudinary.com/example/tin.pdf',
  })
  tinDocumentUrl?: string;

  @ApiPropertyOptional({
    description: 'NIN slip URL — NON_REGISTERED vendors only',
    example: 'https://res.cloudinary.com/example/nin.jpg',
  })
  ninDocumentUrl?: string;

  @ApiPropertyOptional({
    description: 'Passport photograph URL — NON_REGISTERED vendors only',
    example: 'https://res.cloudinary.com/example/passport.jpg',
  })
  passportPhotoUrl?: string;

  @ApiPropertyOptional({
    description: 'Bank statement URL — NON_REGISTERED vendors only',
    example: 'https://res.cloudinary.com/example/bank-statement.pdf',
  })
  bankStatementUrl?: string;

  @ApiPropertyOptional({
    description: 'Utility bill URL — NON_REGISTERED vendors only',
    example: 'https://res.cloudinary.com/example/utility-bill.pdf',
  })
  utilityBillUrl?: string;
}
