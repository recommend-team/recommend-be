import 'dotenv/config';
import { DataSource } from 'typeorm';
import { typeOrmConfig } from './src/config/database/db.config.js';
export const AppDataSource = new DataSource(typeOrmConfig);
