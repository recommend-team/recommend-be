import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IsNull, Repository } from 'typeorm';
import { State } from './entities/state.entity';
import { Area } from './entities/area.entity';
import { AreaAlias } from './entities/area-alias.entity';
import { UnplacedLocation } from './entities/unplaced-location.entity';
import { normalisePlace } from './place-match';
import { PLACES_CHANGED_EVENT } from '../../common/events/places-changed.event';

export interface AreaOverview {
  id: string;
  name: string;
  isActive: boolean;
  vendorCount: number;
  aliases: { id: string; name: string }[];
}

export interface StateOverview {
  id: string;
  name: string;
  isActive: boolean;
  areas: AreaOverview[];
}

/** Most asked-about first; a few hundred at most, so never paged. */
const UNPLACED_SHOWN = 200;

/**
 * What the admin Areas page runs on: every area with the other names buyers use for
 * places inside it ("Badore" is in Ajah), and the places buyers gave that nobody has
 * placed yet — to put in an area with one click.
 */
@Injectable()
export class AreaNamesService {
  constructor(
    @InjectRepository(State)
    private readonly states: Repository<State>,
    @InjectRepository(Area)
    private readonly areas: Repository<Area>,
    @InjectRepository(AreaAlias)
    private readonly aliases: Repository<AreaAlias>,
    @InjectRepository(UnplacedLocation)
    private readonly unplaced: Repository<UnplacedLocation>,
    private readonly events: EventEmitter2,
  ) {}

  /** Every state, its areas (switched off ones too), their vendors and other names. */
  async overview(): Promise<StateOverview[]> {
    const [states, areas, aliases, counts] = await Promise.all([
      this.states.find({ order: { name: 'ASC' } }),
      this.areas.find({ order: { name: 'ASC' } }),
      this.aliases.find({ order: { name: 'ASC' } }),
      this.areas.query<{ areaId: string; count: number }[]>(
        `SELECT "areaId", COUNT(*)::int AS count FROM vendor_service_areas GROUP BY "areaId"`,
      ),
    ]);
    const vendors = new Map(counts.map((row) => [row.areaId, row.count]));

    return states.map((state) => ({
      id: state.id,
      name: state.name,
      isActive: state.isActive,
      areas: areas
        .filter((area) => area.stateId === state.id)
        .map((area) => ({
          id: area.id,
          name: area.name,
          isActive: area.isActive,
          vendorCount: vendors.get(area.id) ?? 0,
          aliases: aliases
            .filter((alias) => alias.areaId === area.id)
            .map(({ id, name }) => ({ id, name })),
        })),
    }));
  }

  /** "Badore" is in Ajah. One name, one area: the same name twice is refused. */
  async addAlias(areaId: string, name: string): Promise<AreaAlias> {
    const area = await this.areas.findOne({ where: { id: areaId } });
    if (!area) throw new NotFoundException('Area not found');

    const shown = name.trim().replace(/\s+/g, ' ');
    const normalised = normalisePlace(shown);
    if (normalised.length < 2) {
      throw new BadRequestException('Give the place a name');
    }

    // An area's own name already finds it — "Lekki" as another name for Ajah would
    // send Lekki buyers to Ajah.
    const allAreas = await this.areas.find();
    const asArea = allAreas.find(
      (other) => normalisePlace(other.name) === normalised,
    );
    if (asArea) {
      throw new ConflictException(
        `"${shown}" is already the area ${asArea.name}`,
      );
    }

    const taken = await this.aliases.findOne({
      where: { normalised },
      relations: ['area'],
    });
    if (taken) {
      throw new ConflictException(
        `"${taken.name}" is already a name for ${taken.area?.name ?? 'another area'}`,
      );
    }

    const alias = await this.aliases.save(
      this.aliases.create({ areaId, name: shown, normalised }),
    );
    // A place buyers typed that this now explains is no longer unplaced.
    await this.unplaced.update(
      { normalised, resolvedAreaId: IsNull() },
      { resolvedAreaId: areaId },
    );
    this.changed();
    return alias;
  }

  async removeAlias(id: string): Promise<{ message: string }> {
    const alias = await this.aliases.findOne({ where: { id } });
    if (!alias) throw new NotFoundException('Name not found');
    await this.aliases.remove(alias);
    this.changed();
    return { message: `"${alias.name}" removed` };
  }

  /** Places buyers gave that matched nothing, most asked-about first. */
  async listUnplaced(): Promise<UnplacedLocation[]> {
    return this.unplaced.find({
      where: { resolvedAreaId: IsNull() },
      order: { timesSeen: 'DESC', lastSeenAt: 'DESC' },
      take: UNPLACED_SHOWN,
    });
  }

  /**
   * Put a place buyers typed in an area: it becomes one of the area's other names,
   * written as the admin gives it ("Timbuktu Estate"), or as buyers typed it.
   */
  async placeUnplaced(
    id: string,
    areaId: string,
    name?: string,
  ): Promise<AreaAlias> {
    const row = await this.unplaced.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Place not found');
    const alias = await this.addAlias(areaId, name?.trim() || row.text);
    // Named differently from how buyers typed it, the row still needs closing.
    await this.unplaced.update({ id }, { resolvedAreaId: areaId });
    return alias;
  }

  /** Not a place at all, or not one worth adding: off the list. */
  async dismissUnplaced(id: string): Promise<{ message: string }> {
    const row = await this.unplaced.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Place not found');
    await this.unplaced.remove(row);
    return { message: `"${row.text}" dismissed` };
  }

  /** Areas or names changed: copies of the list elsewhere read it again. */
  changed(): void {
    this.events.emit(PLACES_CHANGED_EVENT);
  }
}
