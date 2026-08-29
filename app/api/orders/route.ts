// app/api/orders/route.ts - Order Sync History & Current Date Sync API
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { fetchRecentOrdersREST } from '@/lib/shopify';
import { processOrderCreatedWebhook } from '@/app/api/webhooks/shopify/route';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const syncToday = url.searchParams.get('syncToday');

  if (syncToday === 'true') {
    await syncCurrentDateOrders();
  }

  const orderSyncs = await db.getOrderSyncs(50);
  return NextResponse.json({ orderSyncs });
}

export async function POST(req: NextRequest) {
  try {
    const summary = await syncCurrentDateOrders();
    const orderSyncs = await db.getOrderSyncs(50);
    return NextResponse.json({
      message: `Sync completed for current date orders.`,
      ...summary,
      orderSyncs
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function syncCurrentDateOrders() {
  const stores = await db.getAllStores();

  // Get current date starting at midnight UTC
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const createdMin = today.toISOString();

  let totalFetched = 0;
  const storeSummaries: any[] = [];

  for (const store of stores) {
    if (!store.accessToken) continue;

    const orders = await fetchRecentOrdersREST(store.shopDomain, store.accessToken, createdMin);
    totalFetched += orders.length;
    storeSummaries.push({ store: store.name, shopDomain: store.shopDomain, ordersCount: orders.length });

    for (const order of orders) {
      await processOrderCreatedWebhook(order, store.shopDomain, store);
    }
  }

  await db.addLog('INFO', `🔄 Today's Order Sync Completed: Scanned ${totalFetched} order(s) placed today across connected stores.`, 'orders_sync_today');

  return {
    totalOrdersFetchedToday: totalFetched,
    stores: storeSummaries
  };
}
