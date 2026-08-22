import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
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

    /*
     * Buyers name places loosely — "Egbeda Junction", "around Ikeja", "Lagos". A single
     * whole-phrase LIKE found none of those: "Egbeda Junction" is not a substring of
     * "Egbeda", and "Lagos" is a state, not an area.
     *
     * So: match if ANY word hits an area name, or if a word names the state (which
     * returns that state's areas as candidates for the buyer to choose from).
     */
    const words = needle
      .replace(/[%_]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 5);

    if (words.length === 0) return [];

    const areas = await this.baseQuery()
      .andWhere(
        new Brackets((where) => {
          words.forEach((word, index) => {
            where
              .orWhere(`area.name ILIKE :w${index}`, {
                [`w${index}`]: `%${word}%`,
              })
              .orWhere(`state.name ILIKE :w${index}`, {
                [`w${index}`]: `%${word}%`,
              });
          });
        }),
      )
      .orderBy('area.name', 'ASC')
      .take(wanted * 6)
      .getMany();

    /*
     * An exact name match wins outright. "Lekki" matching both "Lekki" and "Ibeju-Lekki"
     * would otherwise be treated as ambiguous, and the buyer gets asked which they meant
     * when they already said it precisely.
     */
    const exact = areas.filter((area) =>
      words.some((word) => area.name.toLowerCase() === word.toLowerCase()),
    );
    if (exact.length === 1) return exact.map(toAreaSummary);

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
