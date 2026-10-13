import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import type { DatabaseTls } from '../configuration';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        ({
          type: 'postgres',
          url: configService.get<string>('database.url'),
          // From DATABASE_CA_CERT (verified) or DATABASE_SSL=true (encrypted, unverified);
          // undefined for a local Postgres. A managed Postgres signs with its own CA, so
          // without one of them the app cannot connect at all.
          ssl: configService.get<DatabaseTls>('database.ssl'),
          synchronize: configService.get<boolean>('database.synchronize'),
          logging: configService.get<boolean>('database.logging'),
          migrationsRun: configService.get<boolean>('database.migrationsRun'),
          dropSchema: configService.get<boolean>('database.dropSchema'),
          autoLoadEntities: true,
          entities: configService.get<string[]>('database.entities'),
          migrations: configService.get<string[]>('database.migrations'),
        }) as DataSourceOptions,
      dataSourceFactory: async (options?: DataSourceOptions) => {
        if (!options) {
          throw new Error('DataSourceOptions are not provided');
        }
        return await new DataSource(options).initialize();
      },
    }),
  ],
})
export class DatabaseModule {}
