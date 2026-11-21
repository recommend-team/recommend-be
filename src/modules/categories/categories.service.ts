import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { Category } from './entities/category.entity';
import { CategoryRateChange } from './entities/category-rate-change.entity';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { DEFAULT_CATEGORY_WORDS } from '../../common/constants/default-categories';
import {
  CATEGORIES_CHANGED_EVENT,
  COMMISSION_RATE_RAISED_EVENT,
  CommissionRateRaisedEvent,
} from '../../common/events/categories.events';
import type {
  ChangeRateDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto';

/** Before admins set anything: what Recommend has always kept. */
const FALLBACK_PERCENT = 20;

export interface CategoryView {
  id: string;
  name: string;
  feePercent: number;
  keywords: string[];
  isActive: boolean;
  /** Vendors in this category. */
  vendorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryList {
  categories: CategoryView[];
  /** What vendors outside every category are charged. */
  standardPercent: number;
  /** Vendors in no category yet — they pay the standard rate. */
  uncategorisedVendors: number;
}

/** A category as a vendor picking one sees it. */
export interface CategoryOption {
  id: string;
  name: string;
  feePercent: number;
}

export interface RateChangeView {
  id: string;
  createdAt: Date;
  previousPercent: number | null;
  newPercent: number | null;
  changedByName: string | null;
}

/** Where a vendor's rate comes from: a rate of their own, their category's, or neither. */
export type RateBasis = 'CUSTOM' | 'CATEGORY' | 'STANDARD';

/** What Recommend keeps of one vendor's sales, and why. */
export interface VendorRate {
  percent: number;
  basis: RateBasis;
  categoryId: string | null;
  categoryName: string | null;
  /** Their category's rate — what they would pay without a rate of their own. */
  categoryPercent: number | null;
  customPercent: number | null;
  standardPercent: number;
}

/** The fields of a vendor their rate depends on. */
export interface RatedVendor {
  categoryId?: string | null;
  businessCategory?: string | null;
  customFeePercent?: number | null;
}

/** The rates as they stand, for pricing one checkout. */
export interface CommissionRates {
  standardPercent: number;
  rateOf(vendor: RatedVendor): VendorRate;
  percentFor(vendor: RatedVendor): number;
}

/** A vendor in no category, and the category their own words point at, if any. */
export interface UncategorisedVendor {
  id: string;
  businessName: string | null;
  /** What they typed. */
  businessCategory: string | null;
  status: string | null;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
}

export interface Actor {
  id: string;
  role: Role;
}

/** "Hair Extensions " → "hair extensions": how words and names are compared. */
export function cleanWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase, deduplicated, empties dropped — the way they are stored. */
export function cleanWords(words: string[] | undefined): string[] {
  return [...new Set((words ?? []).map(cleanWord).filter(Boolean))];
}

/** "wigs" → "wig", "dresses" → "dress"; other words as they are. */
function singular(word: string): string {
  if (word.length > 4 && /(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * The one category a vendor's own description points at — "Barbecue, food" is a
 * Restaurant — or null when it points at none, or at two equally.
 */
export function suggestCategory(
  text: string | null | undefined,
  categories: Pick<Category, 'id' | 'name' | 'keywords'>[],
): Pick<Category, 'id' | 'name'> | null {
  const said = cleanWord(text ?? '');
  if (!said) return null;
  const padded = ` ${said} `;
  const tokens = new Set(
    said.split(' ').flatMap((token) => [token, singular(token)]),
  );

  let best: Pick<Category, 'id' | 'name'> | null = null;
  let bestScore = 0;
  let tied = false;
  for (const category of categories) {
    const words = [cleanWord(category.name), ...category.keywords];
    const score = words.filter((word) =>
      word.includes(' ') ? padded.includes(` ${word} `) : tokens.has(word),
    ).length;
    if (score > bestScore) {
      best = category;
      bestScore = score;
      tied = false;
    } else if (score > 0 && score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

const key = (name: string | null | undefined) =>
  (name ?? '').trim().toLowerCase();

/** "Ada O." — how the person who changed a rate is shown. */
function shortName(user: Pick<User, 'firstName' | 'lastName'>): string {
  return (
    [user.firstName, user.lastName?.[0] ? `${user.lastName[0]}.` : '']
      .filter(Boolean)
      .join(' ') || 'An admin'
  );
}

/**
 * The categories admins manage, which vendors are in them, and what Recommend keeps of
 * each vendor's sales.
 *
 * A vendor's rate is, in order: a rate of their own set by the Super Admin; else their
 * category's; else the standard rate (`PLATFORM_FEE_PERCENT`). When it goes up the
 * vendor is told (`COMMISSION_RATE_RAISED_EVENT`).
 */
@Injectable()
export class CategoriesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectRepository(Category)
    private readonly categories: Repository<Category>,
    @InjectRepository(CategoryRateChange)
    private readonly rateChanges: Repository<CategoryRateChange>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /** The rate for vendors outside every category, and the one new categories start at. */
  standardPercent(): number {
    const configured = this.config.get<number>('platform.feePercent');
    return Number.isFinite(configured) ? Number(configured) : FALLBACK_PERCENT;
  }

  /**
   * At startup: the first time, fill the table with the categories Recommend started
   * with, at the standard rate, so nothing changes for anyone on the day this ships.
   * Then — every time, as it costs one query — put vendors whose category is written
   * exactly as one of these into it.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.addStartingCategories();
      const linked = await this.linkVendorsByName();
      if (linked > 0)
        this.logger.log(`Put ${linked} vendor(s) in their category`);
    } catch (error) {
      // Checkout and the assistant both fall back to what they knew before.
      this.logger.error(
        `Couldn't prepare categories: ${(error as Error).message}`,
      );
    }
  }

  private async addStartingCategories(): Promise<void> {
    if ((await this.categories.count({ withDeleted: true })) > 0) return;
    const percent = this.standardPercent();
    // One at a time, so they keep the order buyers are asked in: food first.
    for (const [name, words] of Object.entries(DEFAULT_CATEGORY_WORDS)) {
      await this.dataSource.transaction(async (manager) => {
        const inserted = await manager
          .createQueryBuilder()
          .insert()
          .into(Category)
          .values({ name, feePercent: percent, keywords: cleanWords(words) })
          .orIgnore() // Another instance started at the same moment.
          .returning(['id'])
          .execute();
        const id = (inserted.raw as { id: string }[])[0]?.id;
        if (id) {
          await manager.insert(CategoryRateChange, {
            categoryId: id,
            previousPercent: null,
            newPercent: percent,
            changedByAdminId: null,
          });
        }
      });
    }
    this.logger.log(`Added the starting categories at ${percent}%`);
    this.events.emit(CATEGORIES_CHANGED_EVENT);
  }

  /** Vendors in no category whose own category is one of these, word for word. */
  private async linkVendorsByName(): Promise<number> {
    const result: unknown = await this.dataSource.query(
      `UPDATE "users" u
          SET "categoryId" = c.id, "businessCategory" = c.name
         FROM "categories" c
        WHERE u.role = $1
          AND u."categoryId" IS NULL
          AND u."businessCategory" IS NOT NULL
          AND LOWER(TRIM(u."businessCategory")) = LOWER(c.name)`,
      [Role.SELLER],
    );
    // node-postgres answers an UPDATE with [rows, count].
    return Array.isArray(result) && typeof result[1] === 'number'
      ? result[1]
      : 0;
  }

  // ─── The list ─────────────────────────────────────────────────────────────

  async list(): Promise<CategoryList> {
    const [categories, counts, uncategorised] = await Promise.all([
      this.categories.find({ order: { isActive: 'DESC', createdAt: 'ASC' } }),
      this.vendorCounts(),
      this.users.count({ where: { role: Role.SELLER, categoryId: IsNull() } }),
    ]);
    return {
      categories: categories.map((category) =>
        this.view(category, counts.get(category.id) ?? 0),
      ),
      standardPercent: this.standardPercent(),
      uncategorisedVendors: uncategorised,
    };
  }

  /** The active categories, for a vendor choosing theirs — with what each costs. */
  async options(): Promise<CategoryOption[]> {
    const active = await this.categories.find({
      where: { isActive: true },
      order: { createdAt: 'ASC', name: 'ASC' },
    });
    return active.map(({ id, name, feePercent }) => ({ id, name, feePercent }));
  }

  /**
   * The category a vendor's chosen name belongs to, written as the category writes it;
   * or none, keeping what they typed. Sign-up, Store details and admins' edits all send
   * a name — from the list, or "something else" in their own words.
   */
  async resolve(
    text: string | null | undefined,
  ): Promise<{ categoryId: string | null; businessCategory: string | null }> {
    const typed = text?.trim() || null;
    if (!typed) return { categoryId: null, businessCategory: null };
    const match = await this.categories
      .createQueryBuilder('category')
      .where('LOWER(category.name) = :name', { name: key(typed) })
      .getOne();
    return match
      ? { categoryId: match.id, businessCategory: match.name }
      : { categoryId: null, businessCategory: typed };
  }

  // ─── Admins' changes ──────────────────────────────────────────────────────

  async create(dto: CreateCategoryDto, actor: Actor): Promise<CategoryView> {
    if (dto.feePercent !== undefined && actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(
        "Only the Super Admin sets Recommend's percentage.",
      );
    }
    const keywords = cleanWords(dto.keywords);
    await this.assertNameFree(dto.name);
    await this.assertWordsFree(keywords, null);

    const percent = dto.feePercent ?? this.standardPercent();
    const saved = await this.dataSource.transaction(async (manager) => {
      const category = await manager.save(
        manager.create(Category, {
          name: dto.name,
          feePercent: percent,
          keywords,
          isActive: true,
          createdByAdminId: actor.id,
        }),
      );
      await manager.insert(CategoryRateChange, {
        categoryId: category.id,
        previousPercent: null,
        newPercent: percent,
        changedByAdminId: actor.id,
      });
      return category;
    });

    this.events.emit(CATEGORIES_CHANGED_EVENT);
    return this.view(saved, 0);
  }

  /**
   * Rename, archive or restore, or change the words. Renaming changes what its vendors'
   * stores say; they stay in it, at its rate.
   */
  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryView> {
    const category = await this.find(id);
    const renamed =
      dto.name !== undefined && dto.name.trim() !== category.name
        ? dto.name.trim()
        : null;

    if (renamed) await this.assertNameFree(renamed, id);
    const keywords =
      dto.keywords !== undefined ? cleanWords(dto.keywords) : undefined;
    if (keywords) await this.assertWordsFree(keywords, id);

    const saved = await this.dataSource.transaction(async (manager) => {
      if (renamed) {
        await manager
          .createQueryBuilder()
          .update(User)
          .set({ businessCategory: renamed })
          .where('"categoryId" = :id', { id })
          .execute();
        category.name = renamed;
      }
      if (keywords) category.keywords = keywords;
      if (dto.isActive !== undefined) category.isActive = dto.isActive;
      return manager.save(category);
    });

    this.events.emit(CATEGORIES_CHANGED_EVENT);
    return this.view(saved, (await this.vendorCounts()).get(id) ?? 0);
  }

  /**
   * Super Admin only. Applies from the next order: orders already placed keep the rate
   * they were charged at. Logged with who changed it; when it goes up, every vendor
   * paying it is told.
   */
  async changeRate(
    id: string,
    dto: ChangeRateDto,
    actor: Actor,
  ): Promise<CategoryView> {
    this.assertSuperAdmin(actor);
    const category = await this.find(id);
    const counts = await this.vendorCounts();
    if (category.feePercent === dto.feePercent) {
      return this.view(category, counts.get(id) ?? 0);
    }

    const previous = category.feePercent;
    const saved = await this.dataSource.transaction(async (manager) => {
      category.feePercent = dto.feePercent;
      const updated = await manager.save(category);
      await manager.insert(CategoryRateChange, {
        categoryId: id,
        previousPercent: previous,
        newPercent: dto.feePercent,
        changedByAdminId: actor.id,
      });
      return updated;
    });
    this.logger.log(
      `${category.name}: ${previous}% → ${dto.feePercent}% (by ${actor.id})`,
    );

    if (dto.feePercent > previous) {
      // Vendors with a rate of their own are unaffected.
      const paying = await this.users.find({
        where: {
          categoryId: id,
          role: Role.SELLER,
          customFeePercent: IsNull(),
        },
        select: ['id'],
      });
      for (const vendor of paying) {
        this.events.emit(
          COMMISSION_RATE_RAISED_EVENT,
          new CommissionRateRaisedEvent(vendor.id, previous, dto.feePercent),
        );
      }
    }

    this.events.emit(CATEGORIES_CHANGED_EVENT);
    return this.view(saved, counts.get(id) ?? 0);
  }

  /** Every rate this category has had, newest first, and who set it. */
  async rateHistory(id: string): Promise<RateChangeView[]> {
    await this.find(id);
    return this.history({ categoryId: id });
  }

  // ─── Vendors ──────────────────────────────────────────────────────────────

  /** Vendors in no category, newest first, each with the category their words suggest. */
  async uncategorised(): Promise<UncategorisedVendor[]> {
    const [vendors, active] = await Promise.all([
      this.users.find({
        where: { role: Role.SELLER, categoryId: IsNull() },
        select: ['id', 'businessName', 'businessCategory', 'status'],
        order: { createdAt: 'DESC' },
        take: 200,
      }),
      this.categories.find({ where: { isActive: true } }),
    ]);
    return vendors.map((vendor) => {
      const suggestion = suggestCategory(vendor.businessCategory, active);
      return {
        id: vendor.id,
        businessName: vendor.businessName,
        businessCategory: vendor.businessCategory,
        status: vendor.status ?? null,
        suggestedCategoryId: suggestion?.id ?? null,
        suggestedCategoryName: suggestion?.name ?? null,
      };
    });
  }

  /**
   * Put vendors in a category. Their store then says its name. Any whose rate goes up
   * as a result are told.
   */
  async assignVendors(
    categoryId: string,
    vendorIds: string[],
  ): Promise<{ moved: number }> {
    const category = await this.find(categoryId);
    const before = await this.percentsOf(vendorIds);
    if (before.size === 0) return { moved: 0 };

    await this.users
      .createQueryBuilder()
      .update(User)
      .set({ categoryId, businessCategory: category.name })
      .where('id IN (:...ids)', { ids: [...before.keys()] })
      .execute();

    await this.announceRaises(before);
    return { moved: before.size };
  }

  /** What Recommend keeps of this vendor's sales, and why. */
  async vendorRate(vendorId: string): Promise<VendorRate> {
    const vendor = await this.findVendor(vendorId);
    return (await this.rates()).rateOf(vendor);
  }

  /**
   * Super Admin only: agree this vendor's own rate, or (null) remove it so their
   * category's applies again. Logged; they are told if it means paying more.
   */
  async setVendorRate(
    vendorId: string,
    feePercent: number | null,
    actor: Actor,
  ): Promise<VendorRate> {
    this.assertSuperAdmin(actor);
    const vendor = await this.findVendor(vendorId);
    const rates = await this.rates();
    const before = rates.rateOf(vendor);
    const previousCustom = vendor.customFeePercent;
    if (previousCustom === feePercent) return before;

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        User,
        { id: vendorId },
        { customFeePercent: feePercent },
      );
      await manager.insert(CategoryRateChange, {
        categoryId: null,
        vendorId,
        previousPercent: previousCustom,
        newPercent: feePercent,
        changedByAdminId: actor.id,
      });
    });

    const after = rates.rateOf({ ...vendor, customFeePercent: feePercent });
    if (after.percent > before.percent) {
      this.events.emit(
        COMMISSION_RATE_RAISED_EVENT,
        new CommissionRateRaisedEvent(vendorId, before.percent, after.percent),
      );
    }
    return after;
  }

  /** Every rate of their own this vendor has had, newest first, and who set it. */
  async vendorRateHistory(vendorId: string): Promise<RateChangeView[]> {
    await this.findVendor(vendorId);
    return this.history({ vendorId });
  }

  /**
   * What each of these vendors pays now — before a change, so `announceRaises` can tell
   * the ones who will pay more after it. Only vendors; anything else is left out.
   */
  async percentsOf(vendorIds: string[]): Promise<Map<string, number>> {
    if (vendorIds.length === 0) return new Map();
    const [vendors, rates] = await Promise.all([
      this.users.find({
        where: { id: In(vendorIds), role: Role.SELLER },
        select: ['id', 'categoryId', 'businessCategory', 'customFeePercent'],
      }),
      this.rates(),
    ]);
    return new Map(
      vendors.map((vendor) => [vendor.id, rates.percentFor(vendor)]),
    );
  }

  /** Tell each vendor whose rate is now higher than `before` said. */
  async announceRaises(before: Map<string, number>): Promise<void> {
    const after = await this.percentsOf([...before.keys()]);
    for (const [vendorId, previous] of before) {
      const now = after.get(vendorId);
      if (now !== undefined && now > previous) {
        this.events.emit(
          COMMISSION_RATE_RAISED_EVENT,
          new CommissionRateRaisedEvent(vendorId, previous, now),
        );
      }
    }
  }

  // ─── Checkout ─────────────────────────────────────────────────────────────

  /**
   * The rates as they stand, for pricing one checkout. Read fresh each time — a change
   * applies from the very next order — and archived categories still count: their
   * vendors keep selling at their rate.
   */
  async rates(): Promise<CommissionRates> {
    const standardPercent = this.standardPercent();
    const all = await this.categories.find({
      select: ['id', 'name', 'feePercent'],
    });
    const byId = new Map(all.map((category) => [category.id, category]));
    const byName = new Map(
      all.map((category) => [key(category.name), category]),
    );

    const rateOf = (vendor: RatedVendor): VendorRate => {
      // Linked by id; a vendor not yet linked still counts if they wrote its name.
      const category =
        (vendor.categoryId ? byId.get(vendor.categoryId) : undefined) ??
        byName.get(key(vendor.businessCategory));
      const custom = vendor.customFeePercent ?? null;
      const basis: RateBasis =
        custom !== null ? 'CUSTOM' : category ? 'CATEGORY' : 'STANDARD';
      return {
        percent: custom ?? category?.feePercent ?? standardPercent,
        basis,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        categoryPercent: category?.feePercent ?? null,
        customPercent: custom,
        standardPercent,
      };
    };

    return {
      standardPercent,
      rateOf,
      percentFor: (vendor) => rateOf(vendor).percent,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private assertSuperAdmin(actor: Actor): void {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(
        "Only the Super Admin changes Recommend's percentage.",
      );
    }
  }

  private async find(id: string): Promise<Category> {
    const category = await this.categories.findOne({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  private async findVendor(id: string): Promise<User> {
    const vendor = await this.users.findOne({
      where: { id, role: Role.SELLER },
      select: ['id', 'categoryId', 'businessCategory', 'customFeePercent'],
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  private async history(where: {
    categoryId?: string;
    vendorId?: string;
  }): Promise<RateChangeView[]> {
    const changes = await this.rateChanges.find({
      where,
      order: { createdAt: 'DESC' },
    });
    const adminIds = [
      ...new Set(
        changes
          .map((change) => change.changedByAdminId)
          .filter((adminId): adminId is string => !!adminId),
      ),
    ];
    const admins = adminIds.length
      ? await this.users.find({
          where: { id: In(adminIds) },
          select: ['id', 'firstName', 'lastName'],
          withDeleted: true,
        })
      : [];
    const names = new Map(admins.map((admin) => [admin.id, shortName(admin)]));
    return changes.map((change) => ({
      id: change.id,
      createdAt: change.createdAt,
      previousPercent: change.previousPercent,
      newPercent: change.newPercent,
      changedByName: change.changedByAdminId
        ? (names.get(change.changedByAdminId) ?? 'An admin')
        : null,
    }));
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const clash = await this.categories
      .createQueryBuilder('category')
      .where('LOWER(category.name) = :name', { name: key(name) })
      .getOne();
    if (clash && clash.id !== exceptId) {
      throw new ConflictException(
        `There is already a category called ${clash.name}.`,
      );
    }
  }

  /**
   * A word may point at one category only — "charger" can't mean both Phone Accessories
   * and Gadgets, or the assistant looks in the wrong place. Other categories' names count
   * as taken too.
   */
  private async assertWordsFree(
    words: string[],
    exceptId: string | null,
  ): Promise<void> {
    if (words.length === 0) return;
    const others = (
      await this.categories.find({ where: { isActive: true } })
    ).filter((category) => category.id !== exceptId);
    const owner = new Map<string, string>();
    for (const category of others) {
      owner.set(cleanWord(category.name), category.name);
      for (const word of category.keywords) owner.set(word, category.name);
    }
    const clashes = words
      .filter((word) => owner.has(word))
      .map((word) => `"${word}" (${owner.get(word)})`);
    if (clashes.length > 0) {
      const one = clashes.length === 1;
      throw new ConflictException(
        `${one ? 'This word already belongs' : 'These words already belong'} to another category: ${clashes.join(', ')}. Remove ${one ? 'it' : 'them'} there first, or leave ${one ? 'it' : 'them'} out.`,
      );
    }
  }

  /** Vendors per category id. */
  private async vendorCounts(): Promise<Map<string, number>> {
    const rows = await this.users
      .createQueryBuilder('vendor')
      .select('vendor.categoryId', 'categoryId')
      .addSelect('COUNT(*)', 'count')
      .where('vendor.role = :role', { role: Role.SELLER })
      .andWhere('vendor.categoryId IS NOT NULL')
      .groupBy('vendor.categoryId')
      .getRawMany<{ categoryId: string; count: string }>();
    return new Map(rows.map((row) => [row.categoryId, Number(row.count)]));
  }

  private view(category: Category, vendorCount: number): CategoryView {
    return {
      id: category.id,
      name: category.name,
      feePercent: category.feePercent,
      keywords: category.keywords,
      isActive: category.isActive,
      vendorCount,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
    };
  }
}
