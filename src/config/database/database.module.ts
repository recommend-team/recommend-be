import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        ({
          type: 'postgres',
          url: configService.get<string>('database.url'),
          // Set when DATABASE_SSL=true, and undefined otherwise. A managed Postgres
          // signs with its own CA, so without this the app cannot connect at all.
          ssl: configService.get<{ rejectUnauthorized: boolean } | undefined>(
            'database.ssl',
          ),
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
