import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map((e) => ({
          field: e.path.join('.') || 'value',
          message: e.message,
        }));
        throw new BadRequestException({ message: 'Validation failed', errors });
      }
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [],
      });
    }
  }

  static create(schema: ZodSchema) {
    return new ZodValidationPipe(schema);
  }
}
