import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Area } from '../../modules/locations/entities/area.entity';
import { AreaSummary, LocationPort } from '../ports/location.port';

/**
 * In-process implementation of `LocationPort`.
 */
@Injectable()
export class LocalLocationAdapter implements LocationPort {
  constructor(
    @InjectRepository(Area)
    private readonly areasRepository: Repository<Area>,
  ) {}

  async searchAreas(text: string, limit = 5): Promise<AreaSummary[]> {
    const needle = text.trim();
    if (!needle) return [];

    const wanted = clamp(limit);
    const areas = await this.baseQuery()
      .andWhere('area.name ILIKE :needle', { needle: `%${needle}%` })
      .orderBy('area.name', 'ASC')
      .take(wanted * 4)
      .getMany();

    // Closest match first: "Yaba" ahead of "Yaba Estate".
    return areas
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, wanted)
      .map(toAreaSummary);
  }

  async listAreas(limit = 50): Promise<AreaSummary[]> {
    const areas = await this.baseQuery()
      .orderBy('area.name', 'ASC')
      .take(clamp(limit, 200))
      .getMany();

    return areas.map(toAreaSummary);
  }

  async getAreaById(areaId: string): Promise<AreaSummary | null> {
    const area = await this.baseQuery()
      .andWhere('area.id = :areaId', { areaId })
      .getOne();

    return area ? toAreaSummary(area) : null;
  }

  private baseQuery() {
    return this.areasRepository
      .createQueryBuilder('area')
      .innerJoinAndSelect('area.state', 'state')
      .where('area.isActive = true')
      .andWhere('state.isActive = true');
  }
}

function clamp(value: number, max = 20): number {
  return Math.min(max, Math.max(1, value));
}

function toAreaSummary(area: Area): AreaSummary {
  return {
    id: area.id,
    name: area.name,
    stateName: area.state?.name ?? '',
  };
}
