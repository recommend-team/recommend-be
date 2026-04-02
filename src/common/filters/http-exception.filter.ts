import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

interface ValidationError {
  field: string;
  message: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred';
    let error = 'Internal Server Error';
    let errors: ValidationError[] | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = exception.name;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const body = exceptionResponse as Record<string, unknown>;

        // Zod / custom validation errors: { message, errors: [{field, message}] }
        if (body.errors && Array.isArray(body.errors)) {
          message = (body.message as string) || 'Validation failed';
          errors = body.errors as ValidationError[];
          error = 'Bad Request';
        } else if (body.message) {
          // NestJS class-validator format: { message: string | string[] }
          const rawMessage = body.message;
          if (Array.isArray(rawMessage)) {
            message = 'Validation failed';
            errors = rawMessage.map((msg: string) => ({
              field: 'unknown',
              message: msg,
            }));
            error = 'Bad Request';
          } else {
            message = rawMessage as string;
            error = (body.error as string) || exception.name;
          }
        } else {
          message = exception.message;
          error = exception.name;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;
    }

    const responseBody: Record<string, unknown> = {
      success: false,
      message,
      error,
      statusCode,
      timestamp: new Date().toISOString(),
    };

    if (errors) {
      responseBody.errors = errors;
    }

    response.status(statusCode).json(responseBody);
  }
}
