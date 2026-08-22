import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { State } from './entities/state.entity';
import { Area } from './entities/area.entity';
import { UnmappedVendorArea } from './entities/unmapped-vendor-area.entity';
import {
  CreateAreaDto,
  CreateStateDto,
  UpdateAreaDto,
  UpdateStateDto,
} from './dto/location.dto';

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    @InjectRepository(State)
    private readonly statesRepository: Repository<State>,
    @InjectRepository(Area)
    private readonly areasRepository: Repository<Area>,
    @InjectRepository(UnmappedVendorArea)
    private readonly unmappedRepository: Repository<UnmappedVendorArea>,
  ) {}

  // ─── States ─────────────────────────────────────────────────────────────────

  async listStates(includeInactive = false): Promise<State[]> {
    return this.statesRepository.find({
      where: includeInactive ? {} : { isActive: true },
      order: { name: 'ASC' },
    });
  }

  async getState(id: string): Promise<State> {
    const state = await this.statesRepository.findOne({ where: { id } });
    if (!state) throw new NotFoundException('State not found');
    return state;
  }

  async createState(dto: CreateStateDto): Promise<State> {
    await this.assertStateNameFree(dto.name);

    const state = this.statesRepository.create({
      name: dto.name.trim(),
      code: dto.code?.trim().toUpperCase() ?? null,
      isActive: dto.isActive ?? true,
    });
    return this.statesRepository.save(state);
  }

  async updateState(id: string, dto: UpdateStateDto): Promise<State> {
    const state = await this.getState(id);

    if (dto.name !== undefined && dto.name.trim() !== state.name) {
      await this.assertStateNameFree(dto.name);
      state.name = dto.name.trim();
    }
    if (dto.code !== undefined) {
      state.code = dto.code ? dto.code.trim().toUpperCase() : null;
    }
    if (dto.isActive !== undefined) state.isActive = dto.isActive;

    return this.statesRepository.save(state);
  }

  /**
   * The normal way to retire a state. Areas inside it are left intact — deactivating
   * the parent is enough to take the whole tree out of circulation, and nothing a
   * vendor already selected is destroyed.
   */
  async setStateActive(id: string, isActive: boolean): Promise<State> {
    const state = await this.getState(id);
    state.isActive = isActive;
    return this.statesRepository.save(state);
  }

  /** Hard delete — permitted only when the state holds no areas at all. */
  async deleteState(id: string): Promise<{ message: string }> {
    const state = await this.getState(id);
    const areaCount = await this.areasRepository.count({
      where: { stateId: id },
    });

    if (areaCount > 0) {
      throw new ConflictException(
        `Cannot delete "${state.name}" — it still has ${areaCount} area(s). ` +
          'Deactivate it instead, or delete its areas first.',
      );
    }

    await this.statesRepository.remove(state);
    return { message: `State "${state.name}" deleted` };
  }

  // ─── Areas ──────────────────────────────────────────────────────────────────

  async listAreasByState(
    stateId: string,
    includeInactive = false,
  ): Promise<Area[]> {
    await this.getState(stateId);
    return this.areasRepository.find({
      where: includeInactive ? { stateId } : { stateId, isActive: true },
      order: { name: 'ASC' },
    });
  }

  async getArea(id: string): Promise<Area> {
    const area = await this.areasRepository.findOne({
      where: { id },
      relations: ['state'],
    });
    if (!area) throw new NotFoundException('Area not found');
    return area;
  }

  async createArea(dto: CreateAreaDto): Promise<Area> {
    await this.getState(dto.stateId);
    await this.assertAreaNameFree(dto.stateId, dto.name);

    const area = this.areasRepository.create({
      stateId: dto.stateId,
      name: dto.name.trim(),
      isActive: dto.isActive ?? true,
    });
    return this.areasRepository.save(area);
  }

  async updateArea(id: string, dto: UpdateAreaDto): Promise<Area> {
    const area = await this.getArea(id);
    const targetStateId = dto.stateId ?? area.stateId;

    if (dto.stateId !== undefined && dto.stateId !== area.stateId) {
      await this.getState(dto.stateId);
      area.stateId = dto.stateId;
    }
    if (dto.name !== undefined && dto.name.trim() !== area.name) {
      await this.assertAreaNameFree(targetStateId, dto.name);
      area.name = dto.name.trim();
    }
    if (dto.isActive !== undefined) area.isActive = dto.isActive;

    return this.areasRepository.save(area);
  }

  async setAreaActive(id: string, isActive: boolean): Promise<Area> {
    const area = await this.getArea(id);
    area.isActive = isActive;
    return this.areasRepository.save(area);
  }

  /**
   * Hard delete — permitted only when no vendor serves the area. Destroying an area
   * vendors reference would remove them from discovery with no trace of why.
   */
  async deleteArea(id: string): Promise<{ message: string }> {
    const area = await this.getArea(id);
    const vendorCount = await this.countVendorsServingArea(id);

    if (vendorCount > 0) {
      throw new ConflictException(
        `Cannot delete "${area.name}" — ${vendorCount} vendor(s) serve it. ` +
          'Deactivate it instead.',
      );
    }

    await this.areasRepository.remove(area);
    return { message: `Area "${area.name}" deleted` };
  }

  /** How many vendors currently list this area as one they serve. */
  async countVendorsServingArea(areaId: string): Promise<number> {
    const rows: unknown = await this.areasRepository.query(
      'SELECT COUNT(*)::int AS count FROM vendor_service_areas WHERE "areaId" = $1',
      [areaId],
    );
    const [first] = rows as { count?: number }[];
    return first?.count ?? 0;
  }

  /**
   * Resolve the area ids a vendor submitted, rejecting anything that does not exist
   * or has been deactivated. Callers assign the result to the vendor relation.
   */
  async findActiveAreasByIds(areaIds: string[]): Promise<Area[]> {
    if (areaIds.length === 0) return [];

    const unique = [...new Set(areaIds)];
    const areas = await this.areasRepository.find({
      where: { id: In(unique), isActive: true },
    });

    if (areas.length !== unique.length) {
      const found = new Set(areas.map((area) => area.id));
      const missing = unique.filter((id) => !found.has(id));
      throw new BadRequestException(
        `Unknown or inactive area(s): ${missing.join(', ')}`,
      );
    }

    return areas;
  }

  // ─── Backfill report ────────────────────────────────────────────────────────

  async listUnmappedAreas(
    includeResolved = false,
  ): Promise<UnmappedVendorArea[]> {
    return this.unmappedRepository.find({
      where: includeResolved ? {} : { resolved: false },
      order: { createdAt: 'ASC' },
    });
  }

  async resolveUnmapped(id: string): Promise<{ message: string }> {
    const row = await this.unmappedRepository.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Report entry not found');

    row.resolved = true;
    await this.unmappedRepository.save(row);
    return { message: 'Marked as resolved' };
  }

  // ─── Guards ─────────────────────────────────────────────────────────────────

  private async assertStateNameFree(name: string): Promise<void> {
    const existing = await this.statesRepository
      .createQueryBuilder('state')
      .where('LOWER(state.name) = LOWER(:name)', { name: name.trim() })
      .getOne();

    if (existing) {
      throw new ConflictException(`State "${existing.name}" already exists`);
    }
  }

  private async assertAreaNameFree(
    stateId: string,
    name: string,
  ): Promise<void> {
    const existing = await this.areasRepository
      .createQueryBuilder('area')
      .where('area.stateId = :stateId', { stateId })
      .andWhere('LOWER(area.name) = LOWER(:name)', { name: name.trim() })
      .getOne();

    if (existing) {
      throw new ConflictException(
        `Area "${existing.name}" already exists in this state`,
      );
    }
  }
}
