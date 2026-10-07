import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

/** The website's contact form. Redis comes from the global RedisModule. */
@Module({
  imports: [CommonModule],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
