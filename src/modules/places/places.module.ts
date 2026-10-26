import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Area } from '../locations/entities/area.entity';
import { AreaAlias } from '../locations/entities/area-alias.entity';
import { GooglePlacesClient } from './google-places.client';
import { PlacesService } from './places.service';
import { PlacesController } from './places.controller';

/** Delivery addresses picked from Google Places — for checkout in every channel. */
@Module({
  imports: [TypeOrmModule.forFeature([Area, AreaAlias])],
  controllers: [PlacesController],
  providers: [GooglePlacesClient, PlacesService],
  exports: [PlacesService],
})
export class PlacesModule {}
