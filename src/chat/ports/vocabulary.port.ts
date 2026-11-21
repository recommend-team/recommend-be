export const VOCABULARY_PORT = Symbol('VOCABULARY_PORT');

/** A category Recommend offers, and the words buyers use for it. */
export interface CategoryVocabulary {
  name: string;
  keywords: string[];
}

/** The categories admins keep, so the assistant knows what to offer and where to look. */
export interface VocabularyPort {
  /** Active categories only, oldest first — the order buyers are asked in. */
  activeCategories(): Promise<CategoryVocabulary[]>;
}
