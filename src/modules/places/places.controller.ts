import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PlacesService } from './places.service';

/**
 * Counted per buyer, not per server: behind Heroku's router every request comes from
 * the router, so the buyer's address is the first one it forwarded.
 */
@Injectable()
class PerBuyerThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): string {
    const forwarded = (req.headers as Record<string, string | undefined>)?.[
      'x-forwarded-for'
    ];
    const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
    return forwarded?.split(',')[0]?.trim() || ip;
  }
}

const SESSION = /^[A-Za-z0-9_-]{8,64}$/;

function session(token?: string): string | undefined {
  if (!token) return undefined;
  if (!SESSION.test(token))
    throw new BadRequestException('Invalid session token');
  return token;
}

/**
 * Delivery addresses picked from Google Places. Open to anyone — buyers on the
 * storefront and in the chat aren't signed in — so each is rate-limited per buyer: every
 * call costs money.
 */
@ApiTags('Places')
@Controller('places')
@Public()
@UseGuards(PerBuyerThrottlerGuard)
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get('suggest')
  @Throttle(60, 60)
  @ApiOperation({ summary: 'Address suggestions for what the buyer is typing' })
  @ApiQuery({ name: 'q', description: 'What the buyer typed so far' })
  @ApiQuery({
    name: 'session',
    required: false,
    description:
      'One token for one address search, from first keystroke to the pick',
  })
  @ApiQuery({
    name: 'areaId',
    required: false,
    description: 'The buyer’s area, when known — suggestions lean towards it',
  })
  async suggest(
    @Query('q') q = '',
    @Query('session') token?: string,
    @Query('areaId') areaId?: string,
  ) {
    const uuid = /^[0-9a-f-]{36}$/i;
    return {
      message: 'Suggestions',
      data: await this.places.suggest(
        q,
        session(token),
        areaId && uuid.test(areaId) ? areaId : undefined,
      ),
    };
  }

  @Get('resolve')
  @Throttle(30, 60)
  @ApiOperation({
    summary:
      'The picked address, our area for it, and a token checkout accepts',
  })
  @ApiQuery({ name: 'placeId' })
  @ApiQuery({ name: 'session', required: false })
  async resolve(
    @Query('placeId') placeId = '',
    @Query('session') token?: string,
  ) {
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) {
      throw new BadRequestException('Invalid placeId');
    }
    return {
      message: 'Place',
      data: await this.places.resolve(placeId, session(token)),
    };
  }
}
