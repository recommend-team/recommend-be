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
          synchronize: configService.get<boolean>('database.synchronize'),
          logging: configService.get<boolean>('database.logging'),
          migrationsRun: configService.get<boolean>('database.migrationsRun'),
          dropSchema: configService.get<boolean>('database.dropSchema'),
          autoLoadEntities: true,
          entities: [__dirname + '/../**/*.entity{.ts,.js}'],
          migrations: [__dirname + '/migrations/*{.ts,.js}'],
        }) as DataSourceOptions,
      dataSourceFactory: async (options: DataSourceOptions) => {
        return await new DataSource(options).initialize();
      },
    }),
  ],
})
export class DatabaseModule {}
