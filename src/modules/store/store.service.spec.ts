import { StoreService } from './store.service';

// Monday 19 October 2026, 8pm in Lagos.
const MONDAY_EVENING = new Date('2026-10-19T20:00:00+01:00');

const day = (isOpen: boolean, open: string, close: string) => ({
  isOpen,
  open,
  close,
});
const hours = (mondayClose: string) => ({
  monday: day(true, '09:00', mondayClose),
  tuesday: day(true, '08:00', '18:00'),
  wednesday: day(true, '09:00', '19:00'),
  thursday: day(true, '09:00', '19:00'),
  friday: day(true, '09:00', '19:00'),
  saturday: day(false, '00:00', '00:00'),
  sunday: day(false, '00:00', '00:00'),
});

const vendor = (over: Record<string, unknown>) => ({
  id: 'v1',
  businessName: 'Mama Put',
  slug: 'mama-put',
  serviceAreas: [],
  isOpen: true,
  operatingHours: null,
  ...over,
});

const serviceFor = (found: ReturnType<typeof vendor>) =>
  new StoreService(
    {
      findOne: jest.fn().mockResolvedValue(found),
      findAndCount: jest.fn().mockResolvedValue([[found], 1]),
    } as never,
    { findAvailableByVendor: jest.fn().mockResolvedValue([]) } as never,
    { get: jest.fn() } as never,
  );

describe('StoreService — open now, for buyers', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: MONDAY_EVENING, doNotFake: ['nextTick'] });
  });
  afterEach(() => jest.useRealTimers());

  it('shows a vendor past closing time as closed, with when they open', async () => {
    const shop = serviceFor(vendor({ operatingHours: hours('19:00') }));

    const { data } = await shop.getStorefront('mama-put');

    expect(data.vendor).toMatchObject({
      isOpen: false,
      opensAt: '2026-10-20T07:00:00.000Z',
      closesAt: null,
    });
    // The week is still sent, so the page can show it.
    expect(data.vendor.operatingHours).toEqual(hours('19:00'));
  });

  it('shows a vendor inside their hours as open, with when they close', async () => {
    const shop = serviceFor(vendor({ operatingHours: hours('22:00') }));

    const { data } = await shop.getStorefront('mama-put');

    expect(data.vendor).toMatchObject({
      isOpen: true,
      opensAt: null,
      closesAt: '2026-10-19T21:00:00.000Z',
    });
  });

  it('shows a paused vendor as closed in the store list, whatever their hours', async () => {
    const shop = serviceFor(
      vendor({ isOpen: false, operatingHours: hours('22:00') }),
    );

    const { data } = await shop.getAllStores();

    expect(data.items[0]).toMatchObject({
      isOpen: false,
      opensAt: null,
      closesAt: null,
    });
  });
});
