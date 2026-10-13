import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { getTypeOrmConfig } from '../config/configuration';

// Load .env before reading the config factory — the TypeORM CLI boots this file
// directly, outside the Nest ConfigModule.
config();

export const dataSourceOptions = getTypeOrmConfig();

const dataSource = new DataSource(dataSourceOptions);
export default dataSource;
