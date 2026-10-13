import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── State ────────────────────────────────────────────────────────────────────

export const createStateSchema = z.object({
  name: z.string().min(2, 'State name must be at least 2 characters').max(100),
  code: z.string().min(2).max(10).optional(),
  isActive: z.boolean().optional(),
});

export const updateStateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  code: z.string().min(2).max(10).nullable().optional(),
  isActive: z.boolean().optional(),
});

export type CreateStateDto = z.infer<typeof createStateSchema>;
export type UpdateStateDto = z.infer<typeof updateStateSchema>;

export class CreateStateRequestDto {
  @ApiProperty({ example: 'Lagos' })
  name!: string;

  @ApiPropertyOptional({ example: 'LA' })
  code?: string;

  @ApiPropertyOptional({ example: true, default: true })
  isActive?: boolean;
}

export class UpdateStateRequestDto {
  @ApiPropertyOptional({ example: 'Lagos' })
  name?: string;

  @ApiPropertyOptional({ example: 'LA', nullable: true })
  code?: string | null;

  @ApiPropertyOptional({ example: false })
  isActive?: boolean;
}

// ─── Area ─────────────────────────────────────────────────────────────────────

export const createAreaSchema = z.object({
  stateId: z.string().uuid('stateId must be a valid UUID'),
  name: z.string().min(2, 'Area name must be at least 2 characters').max(100),
  isActive: z.boolean().optional(),
});

export const updateAreaSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  stateId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
});

export type CreateAreaDto = z.infer<typeof createAreaSchema>;
export type UpdateAreaDto = z.infer<typeof updateAreaSchema>;

export class CreateAreaRequestDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  stateId!: string;

  @ApiProperty({ example: 'Yaba' })
  name!: string;

  @ApiPropertyOptional({ example: true, default: true })
  isActive?: boolean;
}

export class UpdateAreaRequestDto {
  @ApiPropertyOptional({ example: 'Yaba' })
  name?: string;

  @ApiPropertyOptional({ example: '123e4567-e89b-12d3-a456-426614174000' })
  stateId?: string;

  @ApiPropertyOptional({ example: false })
  isActive?: boolean;
}
