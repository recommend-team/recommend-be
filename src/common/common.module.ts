import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CleanupService } from './services/cleanup.service';
import { EmailService } from './services/email.service';
import { PendingUser } from '../modules/auth/entities/pending-user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PendingUser])],
  providers: [CleanupService, EmailService],
  exports: [CleanupService, EmailService],
})
export class CommonModule {}
