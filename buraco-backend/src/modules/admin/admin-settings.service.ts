import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemConfigService } from '../../common/system-config/system-config.service';
import { SETTING_BY_KEY, SETTINGS, SettingDef } from './admin-settings.catalog';

const SECRET_LOOKING = /secret|pass|token|private|key$/i;

/**
 * Game settings for super admins. The server owns the list: it says which settings the game
 * really reads (the rest are read-only), checks every value, never sends a secret back to the
 * browser, and never writes a secret into the audit log.
 */
@Injectable()
export class AdminSettingsService {
  constructor(private prisma: PrismaService, private sysConfig: SystemConfigService) {}

  async list() {
    const rows = await this.prisma.systemConfig.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const known = SETTINGS.map((def) => this.view(def, byKey.get(def.key)));
    // Keys in the database that the catalog does not know: shown read-only, masked if they look secret.
    const unknown = rows
      .filter((r) => !SETTING_BY_KEY.has(r.key))
      .map((r) => this.view({ key: r.key, label: r.key, description: 'Not part of the settings list.', group: 'Not connected yet', type: SECRET_LOOKING.test(r.key) ? 'secret' : 'text', connected: false }, r));
    return [...known, ...unknown];
  }

  async set(adminId: string, key: string, raw: string) {
    const def = SETTING_BY_KEY.get(key);
    if (!def) throw new NotFoundException('UNKNOWN_SETTING');
    if (!def.connected) throw new BadRequestException('NOT_CONNECTED');

    const value = this.validate(def, raw);
    const before = await this.prisma.systemConfig.findUnique({ where: { key } });
    if ((before?.value ?? '') === value) return this.view(def, before ?? undefined);

    const row = await this.prisma.systemConfig.upsert({
      where: { key },
      update: { value, updatedBy: adminId },
      create: { key, value, updatedBy: adminId },
    });
    this.sysConfig.invalidate(key);
    await this.prisma.adminAuditLog.create({
      data: {
        adminId, action: 'UPDATE_SETTING', targetType: 'SystemConfig', targetId: key,
        details: def.type === 'secret' ? { label: def.label, changed: true, cleared: value === '' } : { label: def.label, from: before?.value ?? null, to: value },
      },
    });
    return this.view(def, row);
  }

  private validate(def: SettingDef, raw: string): string {
    const value = (raw ?? '').trim();
    switch (def.type) {
      case 'number': {
        if (!/^\d{1,9}$/.test(value)) throw new BadRequestException('NOT_A_NUMBER');
        const n = parseInt(value, 10);
        if (n < (def.min ?? 0) || n > (def.max ?? 1_000_000_000)) throw new BadRequestException('OUT_OF_RANGE');
        return String(n);
      }
      case 'boolean':
        if (value !== 'true' && value !== 'false') throw new BadRequestException('NOT_TRUE_OR_FALSE');
        return value;
      case 'version':
        if (!/^\d+\.\d+\.\d+$/.test(value)) throw new BadRequestException('BAD_VERSION');
        return value;
      default:
        if (value.length > 500) throw new BadRequestException('TOO_LONG');
        return value; // may be empty: the server then uses its own setting
    }
  }

  private view(def: SettingDef, row?: { value: string; updatedAt: Date }) {
    const value = row?.value ?? '';
    const secret = def.type === 'secret';
    return {
      key: def.key, label: def.label, description: def.description, group: def.group, type: def.type,
      unit: def.unit ?? null, connected: def.connected, min: def.min ?? null, max: def.max ?? null,
      fallback: def.fallback ?? null,
      // A secret is never sent back, only whether it is set.
      value: secret ? null : value,
      isSet: value.trim() !== '',
      updatedAt: row?.updatedAt ?? null,
    };
  }
}
