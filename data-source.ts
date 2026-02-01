import 'dotenv/config';
import { DataSource } from 'typeorm';
import { getTypeOrmConfig } from './src/config/configuration';
export const AppDataSource = new DataSource(getTypeOrmConfig());
