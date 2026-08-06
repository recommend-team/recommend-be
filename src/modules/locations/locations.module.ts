import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { State } from './entities/state.entity';
import { Area } from './entities/area.entity';
import { UnmappedVendorArea } from './entities/unmapped-vendor-area.entity';
import { LocationsService } from './locations.service';
import { LocationsController } from './locations.controller';
import { AdminLocationsController } from './admin-locations.controller';

@Module({
  imports: [TypeOrmModule.forFeature([State, Area, UnmappedVendorArea])],
  controllers: [LocationsController, AdminLocationsController],
  providers: [LocationsService],
  // SellersService resolves submitted area ids through this.
  exports: [LocationsService, TypeOrmModule],
})
export class LocationsModule {}
