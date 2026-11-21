import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { Public } from '../auth/decorators/public.decorator';

/** The categories a vendor can choose from — at sign-up, before they have an account. */
@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary:
      'The categories vendors can choose, with what Recommend keeps of each',
  })
  async options() {
    return {
      message: 'Categories retrieved',
      data: await this.categories.options(),
    };
  }
}
