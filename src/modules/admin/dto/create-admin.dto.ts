import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../../common/enums/roles.enum';

/** What a super admin can make someone: a full admin, or customer service. */
export const staffRoleSchema = z.enum([Role.ADMIN, Role.SUPPORT], {
  message: 'Role must be ADMIN or SUPPORT',
});

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
  /** Left out by older clients: a full admin, as before. */
  role: staffRoleSchema.default(Role.ADMIN),
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

  @ApiProperty({
    enum: [Role.ADMIN, Role.SUPPORT],
    default: Role.ADMIN,
    required: false,
    description: 'SUPPORT is customer service: the chat queue only',
  })
  role?: Role.ADMIN | Role.SUPPORT;
}

export const ChangeAdminRoleSchema = z.object({ role: staffRoleSchema });
export type ChangeAdminRoleDto = z.infer<typeof ChangeAdminRoleSchema>;

export class ChangeAdminRoleSwaggerDto {
  @ApiProperty({ enum: [Role.ADMIN, Role.SUPPORT] })
  role!: Role.ADMIN | Role.SUPPORT;
}
