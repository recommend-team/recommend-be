import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from '../../modules/categories/entities/category.entity';
import type {
  CategoryVocabulary,
  VocabularyPort,
} from '../ports/vocabulary.port';

/** In-process `VocabularyPort`: reads the categories table directly. */
@Injectable()
export class LocalVocabularyAdapter implements VocabularyPort {
  constructor(
    @InjectRepository(Category)
    private readonly categories: Repository<Category>,
  ) {}

  async activeCategories(): Promise<CategoryVocabulary[]> {
    const rows = await this.categories.find({
      where: { isActive: true },
      select: ['name', 'keywords'],
      order: { createdAt: 'ASC', name: 'ASC' },
    });
    return rows.map((row) => ({
      name: row.name,
      keywords: row.keywords ?? [],
    }));
  }
}
