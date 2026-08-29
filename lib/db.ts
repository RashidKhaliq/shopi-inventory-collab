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
    const cleanName = supplierName.trim().toLowerCase();
    if (process.env.DATABASE_URL) {
      try {
        const stores = await prisma.store.findMany({ where: { isActive: true } });
        const match = stores.find(s => s.supplierName.trim().toLowerCase() === cleanName);
        if (match) return match;
      } catch (err) {
        console.warn('Prisma DB error, falling back to memory:', err);
      }
    }
    for (const store of this.stores.values()) {
      if (store.supplierName.trim().toLowerCase() === cleanName) {
        return store;
      }
    }
    return null;
  }

  public async getAllStores(): Promise<MockStore[]> {
    if (process.env.DATABASE_URL) {
      try {
        return await prisma.store.findMany({ orderBy: { createdAt: 'desc' } });
      } catch (err) {
        console.warn('Prisma DB error, falling back to memory:', err);
      }
    }
    return Array.from(this.stores.values());
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
