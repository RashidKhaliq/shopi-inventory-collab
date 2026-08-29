// lib/db.ts - Serverless Prisma Client Singleton with Fallback
import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export interface MockStore {
  id: string;
  shopDomain: string;
  name: string;
  accessToken: string;
  ownerEmail: string;
  supplierName: string;
  webhookSecret?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockSyncLog {
  id: string;
  level: string;
  topic?: string | null;
  shopDomain?: string | null;
  message: string;
  details?: string | null;
  createdAt: Date;
}

export interface MockOrderSync {
  id: string;
  sourceShopDomain: string;
  targetShopDomain: string;
  sourceOrderId: string;
  sourceOrderName: string;
  targetOrderId?: string | null;
  targetOrderName?: string | null;
  status: string;
  skus: string;
  error?: string | null;
  createdAt: Date;
}

// In-Memory Fallback Storage if DATABASE_URL is not yet configured
class InMemoryDatabase {
  public stores: Map<string, MockStore> = new Map();
  public processedWebhooks: Set<string> = new Set();
  public logs: MockSyncLog[] = [];
  public orderSyncs: MockOrderSync[] = [];

  constructor() {
    this.seedDefaultStores();
  }

  private seedDefaultStores() {
    if (process.env.STORE_A_URL) {
      const domainA = process.env.STORE_A_URL.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
      this.stores.set(domainA, {
        id: 'store_a',
        shopDomain: domainA,
        name: 'Rashid Store (Store A)',
        accessToken: process.env.STORE_A_ACCESS_TOKEN || '',
        ownerEmail: process.env.STORE_A_OWNER_EMAIL || 'rashidkhaliq88@gmail.com',
        supplierName: 'Rashid',
        webhookSecret: process.env.STORE_A_WEBHOOK_SECRET || null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    if (process.env.STORE_B_URL) {
      const domainB = process.env.STORE_B_URL.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
      this.stores.set(domainB, {
        id: 'store_b',
        shopDomain: domainB,
        name: 'Hamza Store (Store B)',
        accessToken: process.env.STORE_B_ACCESS_TOKEN || '',
        ownerEmail: process.env.STORE_B_OWNER_EMAIL || 'Hamzatvc@gmail.com',
        supplierName: 'Hamza',
        webhookSecret: process.env.STORE_B_WEBHOOK_SECRET || null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }
  }

  private matchesStoreSupplier(store: MockStore, targetName: string): boolean {
    if (!targetName || !targetName.trim()) return false;
    const cleanTarget = targetName.trim().toLowerCase().replace(/\s+/g, '');
    
    const sSupplier = store.supplierName ? store.supplierName.trim().toLowerCase().replace(/\s+/g, '') : '';
    const sName = store.name ? store.name.trim().toLowerCase().replace(/\s+/g, '') : '';
    const sDomain = store.shopDomain ? store.shopDomain.trim().toLowerCase().replace(/\s+/g, '') : '';
    const sEmail = store.ownerEmail ? store.ownerEmail.trim().toLowerCase().replace(/\s+/g, '') : '';

    // 1. Exact clean match
    if (sSupplier === cleanTarget || sName === cleanTarget || sDomain === cleanTarget || sEmail === cleanTarget) {
      return true;
    }

    // 2. Substring / contains match
    if ((sName && sName.includes(cleanTarget)) || (sSupplier && cleanTarget.includes(sSupplier)) || (sName && cleanTarget.includes(sName))) {
      return true;
    }

    // 3. Strip generic terms ("store", "shop", "supplier")
    const stripWords = (str: string) => str.replace(/store|shop|supplier|\(|\)/gi, '');
    const strippedTarget = stripWords(cleanTarget);
    const strippedSupplier = stripWords(sSupplier);
    const strippedName = stripWords(sName);

    if (strippedTarget && ((strippedSupplier && strippedSupplier.includes(strippedTarget)) || (strippedName && strippedName.includes(strippedTarget)) || (strippedSupplier && strippedTarget.includes(strippedSupplier)))) {
      return true;
    }

    return false;
  }

  public async getStoreByDomain(domain: string): Promise<MockStore | null> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    if (process.env.DATABASE_URL) {
      try {
        const store = await prisma.store.findUnique({ where: { shopDomain: cleanDomain } });
        if (store) return store;
      } catch (err) {
        console.warn('Prisma DB error, falling back to memory:', err);
      }
    }
    return this.stores.get(cleanDomain) || null;
  }

  public async getStoreBySupplierName(supplierName: string): Promise<MockStore | null> {
    const stores = await this.getAllStores();
    for (const store of stores) {
      if (this.matchesStoreSupplier(store, supplierName)) {
        return store;
      }
    }
    return null;
  }

  public async getAllStores(): Promise<MockStore[]> {
    let stores: MockStore[] = [];
    if (process.env.DATABASE_URL) {
      try {
        stores = await prisma.store.findMany({ orderBy: { createdAt: 'desc' } });
      } catch (err) {
        console.warn('Prisma DB error, falling back to memory:', err);
      }
    }
    if (stores.length === 0) {
      stores = Array.from(this.stores.values());
    }
    return stores;
  }

  public async saveStore(storeData: Omit<MockStore, 'id' | 'createdAt' | 'updatedAt'>): Promise<MockStore> {
    const cleanDomain = storeData.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    if (process.env.DATABASE_URL) {
      try {
        return await prisma.store.upsert({
          where: { shopDomain: cleanDomain },
          update: { ...storeData, shopDomain: cleanDomain },
          create: { ...storeData, shopDomain: cleanDomain },
        });
      } catch (err) {
        console.warn('Prisma DB save error:', err);
      }
    }
    const store: MockStore = {
      id: `store_${Date.now()}`,
      ...storeData,
      shopDomain: cleanDomain,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.stores.set(cleanDomain, store);
    return store;
  }

  public async isWebhookProcessed(webhookId: string): Promise<boolean> {
    if (!webhookId) return false;
    if (process.env.DATABASE_URL) {
      try {
        const found = await prisma.processedWebhook.findUnique({ where: { webhookId } });
        return !!found;
      } catch (err) {
        console.warn('Prisma DB error:', err);
      }
    }
    return this.processedWebhooks.has(webhookId);
  }

  public async recordWebhookProcessed(webhookId: string, topic: string, shopDomain: string): Promise<void> {
    if (!webhookId) return;
    if (process.env.DATABASE_URL) {
      try {
        await prisma.processedWebhook.create({
          data: { webhookId, topic, shopDomain }
        });
        return;
      } catch (err) {
        console.warn('Prisma record webhook error:', err);
      }
    }
    this.processedWebhooks.add(webhookId);
  }

  public async addLog(level: string, message: string, topic?: string, shopDomain?: string, details?: string): Promise<void> {
    const entry: MockSyncLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      level,
      message,
      topic: topic || null,
      shopDomain: shopDomain || null,
      details: details || null,
      createdAt: new Date()
    };

    console.log(`[${entry.createdAt.toISOString()}] [${level}] ${message}`);

    if (process.env.DATABASE_URL) {
      try {
        await prisma.syncLog.create({
          data: { level, message, topic, shopDomain, details }
        });
        return;
      } catch (err) {
        console.warn('Prisma addLog error:', err);
      }
    }

    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
  }

  public async getRecentLogs(limit = 100): Promise<MockSyncLog[]> {
    if (process.env.DATABASE_URL) {
      try {
        return await prisma.syncLog.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' }
        });
      } catch (err) {
        console.warn('Prisma getRecentLogs error:', err);
      }
    }
    return this.logs.slice(0, limit);
  }

  public async recordOrderSync(syncData: Omit<MockOrderSync, 'id' | 'createdAt'>): Promise<void> {
    if (process.env.DATABASE_URL) {
      try {
        await prisma.orderSync.create({ data: syncData });
        return;
      } catch (err) {
        console.warn('Prisma recordOrderSync error:', err);
      }
    }
    const record: MockOrderSync = {
      id: `sync_${Date.now()}`,
      ...syncData,
      createdAt: new Date()
    };
    this.orderSyncs.unshift(record);
    if (this.orderSyncs.length > 100) this.orderSyncs.pop();
  }

  public async hasOrderBeenSynced(sourceShopDomain: string, sourceOrderId: string): Promise<boolean> {
    if (!sourceOrderId || sourceOrderId === 'N/A') return false;
    const cleanDomain = sourceShopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();

    if (process.env.DATABASE_URL) {
      try {
        const found = await prisma.orderSync.findFirst({
          where: { sourceShopDomain: cleanDomain, sourceOrderId }
        });
        if (found) return true;
      } catch (err) {
        console.warn('Prisma DB error:', err);
      }
    }

    return this.orderSyncs.some(s => s.sourceShopDomain === cleanDomain && s.sourceOrderId === sourceOrderId);
  }

  public async getOrderSyncs(limit = 50): Promise<MockOrderSync[]> {
    if (process.env.DATABASE_URL) {
      try {
        return await prisma.orderSync.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' }
        });
      } catch (err) {
        console.warn('Prisma getOrderSyncs error:', err);
      }
    }
    return this.orderSyncs.slice(0, limit);
  }
}

export const db = new InMemoryDatabase();
