import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  verifyShopifyHmac,
  cleanShopDomain,
  processOrderCreatedWebhook
} from '@/lib/shopify';

export async function POST(req: NextRequest) {
  const topic = req.headers.get('x-shopify-topic');
  const shopHeader = req.headers.get('x-shopify-shop-domain');
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
  const webhookId = req.headers.get('x-shopify-webhook-id');

  const shopDomain = cleanShopDomain(shopHeader || '');
  const rawBody = await req.text();

  if (!shopDomain) {
    return NextResponse.json({ error: 'Missing x-shopify-shop-domain header' }, { status: 400 });
  }

  // 1. Idempotency Check
  if (webhookId) {
    const isProcessed = await db.isWebhookProcessed(webhookId);
    if (isProcessed) {
      await db.addLog('INFO', `Duplicate webhook skipped (Id: ${webhookId})`, topic || 'webhook', shopDomain);
      return NextResponse.json({ message: 'Duplicate webhook skipped' }, { status: 200 });
    }
    await db.recordWebhookProcessed(webhookId, topic || 'unknown', shopDomain);
  }

  // 2. Fetch Store & Verify HMAC
  const store = await db.getStoreByDomain(shopDomain);
  if (!store) {
    await db.addLog('WARN', `Webhook received for unconfigured store domain '${shopDomain}'`, topic || 'webhook', shopDomain);
  } else if (store.webhookSecret) {
    const isValid = verifyShopifyHmac(rawBody, store.webhookSecret, hmacHeader);
    if (!isValid) {
      await db.addLog('ERROR', `Webhook HMAC signature verification failed for ${shopDomain}`, topic || 'webhook', shopDomain);
      return NextResponse.json({ error: 'Invalid HMAC signature' }, { status: 401 });
    }
  }

  let bodyData: any = {};
  try {
    bodyData = JSON.parse(rawBody);
  } catch (err) {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // 3. Process Webhook Topics
  if (topic === 'orders/create') {
    await processOrderCreatedWebhook(bodyData, shopDomain, store);
    return NextResponse.json({ message: 'Order creation webhook processed successfully' }, { status: 200 });
  }

  if (topic === 'orders/fulfilled') {
    await processOrderFulfilledWebhook(bodyData, shopDomain, store);
    return NextResponse.json({ message: 'Order fulfillment webhook processed successfully' }, { status: 200 });
  }

  if (topic === 'orders/paid') {
    await db.addLog('INFO', `💳 Order Paid Notification: Order ${bodyData.name || bodyData.id} marked as Paid on ${shopDomain}`, 'orders/paid', shopDomain);
    return NextResponse.json({ message: 'Order paid webhook acknowledged' }, { status: 200 });
  }

  if (topic === 'orders/updated') {
    await db.addLog('INFO', `📝 Order Updated Notification: Order ${bodyData.name || bodyData.id} updated on ${shopDomain}`, 'orders/updated', shopDomain);
    return NextResponse.json({ message: 'Order updated webhook acknowledged' }, { status: 200 });
  }

  if (topic === 'orders/cancelled') {
    await db.addLog('WARN', `⚠️ Order Cancelled Notification: Order ${bodyData.name || bodyData.id} was cancelled on ${shopDomain}`, 'orders/cancelled', shopDomain);
    return NextResponse.json({ message: 'Order cancellation webhook acknowledged' }, { status: 200 });
  }

  // 4. Process Topic: INVENTORY_LEVELS_UPDATE
  if (topic === 'inventory_levels/update') {
    await processInventoryUpdateWebhook(bodyData, shopDomain, store);
    return NextResponse.json({ message: 'Inventory update webhook processed successfully' }, { status: 200 });
  }

  return NextResponse.json({ message: `Webhook topic '${topic}' received and acknowledged` }, { status: 200 });
}

async function processInventoryUpdateWebhook(payload: any, shopDomain: string, store: any) {
  const inventoryItemId = payload.inventory_item_id;
  const available = payload.available;

  await db.addLog('INFO', `Inventory Level Update received from ${shopDomain}: InventoryItem ${inventoryItemId} -> Available: ${available}`, 'inventory_levels/update', shopDomain);
}

async function processOrderFulfilledWebhook(order: any, shopDomain: string, store: any) {
  const orderName = order.name || `ID_${order.id}`;
  const fulfillments = order.fulfillments || [];
  const trackingNumber = fulfillments[0]?.tracking_number || 'N/A';
  const trackingCompany = fulfillments[0]?.tracking_company || 'Standard Carrier';

  await db.addLog(
    'INFO',
    `🚚 Order Fulfilled: ${orderName} on ${shopDomain} (Carrier: ${trackingCompany}, Tracking #: ${trackingNumber})`,
    'orders/fulfilled',
    shopDomain
  );
}

