import { Entity, Column, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { Exclude } from 'class-transformer';
import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import * as argon2 from 'argon2';

import { BaseEntity } from './base.entity';

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  SELLER = 'SELLER',
}

@Entity('users')
export class User extends BaseEntity {
  @Column()
  @IsString()
  @MinLength(2)
  fullName: string;

  @Column({ unique: true })
  @Index()
  @IsEmail()
  email: string;

  @Column()
  @Exclude()
  password: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.SELLER,
  })
  @IsEnum(UserRole)
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  lastLoginAt: Date;

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.password) {
      this.password = await argon2.hash(this.password);
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    return argon2.verify(this.password, password);
  }
}