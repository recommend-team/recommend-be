import { Role } from '../../../common/enums/roles.enum';
import { SellerStatus } from '../../../common/enums/seller-status.enum';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  status: SellerStatus;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  tokenId: string;
  iat?: number;
  exp?: number;
}
