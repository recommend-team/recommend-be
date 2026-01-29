import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmConfig } from './database/db.config';
import { QueuesModule } from './queues/queues.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(typeOrmConfig),
    QueuesModule,
  ],
})
export class AppModule {}