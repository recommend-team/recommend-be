import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T | null;
  timestamp: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T> | StreamableFile
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T> | StreamableFile> {
    return next.handle().pipe(
      map((response) => {
        // A file — a CSV export, say — goes out as it is, never wrapped in JSON.
        if (response instanceof StreamableFile) return response;

        // If the service returns { message, data } extract both
        if (
          response !== null &&
          typeof response === 'object' &&
          'message' in response &&
          'data' in response
        ) {
          const r = response as Record<string, unknown>;
          return {
            success: true,
            message: r['message'] as string,
            data: r['data'] as T,
            timestamp: new Date().toISOString(),
          };
        }

        // If the service returns { message, ...rest } without a data key
        if (
          response !== null &&
          typeof response === 'object' &&
          'message' in response
        ) {
          const { message, ...data } = response as Record<string, unknown>;
          const hasOtherKeys = Object.keys(data).length > 0;
          return {
            success: true,
            message: message as string,
            data: hasOtherKeys ? (data as T) : null,
            timestamp: new Date().toISOString(),
          };
        }

        // Raw data with no message
        return {
          success: true,
          message: 'Request successful',
          data: response as T,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
