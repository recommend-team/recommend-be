import { CategoryVocabularyService } from './category-vocabulary.service';
import {
  categoriesFor,
  categoryNames,
  defaultCategoryWords,
  useCategoryWords,
} from './synonyms';

describe('CategoryVocabularyService', () => {
  afterEach(() => useCategoryWords(defaultCategoryWords()));

  it('hands the assistant the categories admins keep', async () => {
    const service = new CategoryVocabularyService({
      activeCategories: jest
        .fn()
        .mockResolvedValue([
          ...defaultCategoryWords(),
          { name: 'Pets', keywords: ['dog food'] },
        ]),
    });

    await service.refresh();

    expect(categoriesFor('dog food')).toEqual(['Pets']);
  });

  it("keeps what it knew when the database can't be read", async () => {
    const service = new CategoryVocabularyService({
      activeCategories: jest.fn().mockRejectedValue(new Error('down')),
    });

    await expect(service.refresh()).resolves.toBeUndefined();
    expect(categoryNames()).toContain('Restaurant');
  });
});
