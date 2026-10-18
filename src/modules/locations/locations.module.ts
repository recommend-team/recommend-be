import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { State } from './entities/state.entity';
import { Area } from './entities/area.entity';
import { UnmappedVendorArea } from './entities/unmapped-vendor-area.entity';
import { AreaAlias } from './entities/area-alias.entity';
import { UnplacedLocation } from './entities/unplaced-location.entity';
import { AreaNamesService } from './area-names.service';
import { LocationsService } from './locations.service';
import { LocationsController } from './locations.controller';
import { AdminLocationsController } from './admin-locations.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      State,
      Area,
      UnmappedVendorArea,
      AreaAlias,
      UnplacedLocation,
    ]),
  ],
  controllers: [LocationsController, AdminLocationsController],
  providers: [LocationsService, AreaNamesService],
  // SellersService resolves submitted area ids through this.
  exports: [LocationsService, TypeOrmModule],
})
export class LocationsModule {}
