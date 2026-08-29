// app/api/status/route.ts - System Diagnostics & Store Health Check
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cleanShopDomain } from '@/lib/shopify';
import axios from 'axios';

export async function GET(req: NextRequest) {
  const stores = await db.getAllStores();
  const storeHealthReports = await Promise.all(stores.map(s => testStoreHealth(s)));

  const isDatabaseConfigured = !!process.env.DATABASE_URL;
  const allConnected = storeHealthReports.every(s => s.status === 'CONNECTED');

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    overallStatus: allConnected ? 'HEALTHY' : (storeHealthReports.length === 0 ? 'NO_STORES_CONFIGURED' : 'DEGRADED'),
    databaseConfigured: isDatabaseConfigured,
    storesCount: stores.length,
    stores: storeHealthReports
  });
}

async function testStoreHealth(store: any) {
  const domain = cleanShopDomain(store.shopDomain);
  if (!store.accessToken) {
    return {
      id: store.id,
      shopDomain: domain,
      name: store.name,
      supplierName: store.supplierName,
      ownerEmail: store.ownerEmail,
      status: 'MISSING_TOKEN',
      errorDetails: 'Shopify Admin API Access Token is not set.'
    };
  }

  try {
    const res = await axios.get(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': store.accessToken },
      timeout: 8000
    });

    const shop = res.data?.shop || {};
    return {
      id: store.id,
      shopDomain: domain,
      name: store.name,
      supplierName: store.supplierName,
      ownerEmail: store.ownerEmail,
      status: 'CONNECTED',
      shopName: shop.name,
      planName: shop.plan_name,
      currency: shop.currency
    };
  } catch (err: any) {
    let errorDetails = err.message;
    if (err.response?.status === 401) {
      errorDetails = 'HTTP 401 Unauthorized: Invalid Shopify Access Token.';
    } else if (err.response?.status === 404) {
      errorDetails = 'HTTP 404 Not Found: Check store domain URL.';
    }
    return {
      id: store.id,
      shopDomain: domain,
      name: store.name,
      supplierName: store.supplierName,
      ownerEmail: store.ownerEmail,
      status: 'ERROR',
      errorDetails
    };
  }
}
