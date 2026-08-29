import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  verifyShopifyHmac,
  cleanShopDomain,
  getOrderDetailsGraphQL,
  getProductDetailsREST,
  extractSupplierName,
  createSupplierFulfillmentOrder,
  syncInventoryAcrossStores,
  findVariantIdBySku
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

export async function processOrderCreatedWebhook(order: any, shopDomain: string, sourceStore: any) {
  const orderName = order.name || `OTS-${order.order_number || order.id}`;

  const orderIdStr = String(order.id || '');
  if (orderIdStr && orderIdStr !== 'N/A') {
    const alreadySynced = await db.hasOrderBeenSynced(shopDomain, orderIdStr);
    if (alreadySynced) {
      await db.addLog('INFO', `Order ${orderName} (${orderIdStr}) on ${shopDomain} already present in Order History. Skipping duplicate.`, 'orders/create', shopDomain);
      return;
    }
  }

  await db.addLog('INFO', `📦 Webhook Received: Order ${orderName} created on ${shopDomain}`, 'orders/create', shopDomain);

  // 🛑 Loop Protection Check
  const orderTags = Array.isArray(order.tags) ? order.tags.join(', ') : (order.tags || '');
  if (orderTags.toLowerCase().includes('automated dropship') || orderTags.toLowerCase().includes('soldby-')) {
    await db.addLog('INFO', `🛑 Loop Protection: Order ${orderName} has 'Automated Dropship' or 'Soldby-' tag. Skipping.`, 'orders/create', shopDomain);
    return;
  }

  const retailerStore = sourceStore || {
    shopDomain,
    name: shopDomain,
    supplierName: shopDomain.split('.')[0]
  };

  // Fetch complete order details using GraphQL API
  const parsedOrder = sourceStore?.accessToken
    ? await getOrderDetailsGraphQL(shopDomain, sourceStore.accessToken, String(order.id))
    : null;

  let lineItems: any[] = parsedOrder?.lineItems || [];

  if (lineItems.length === 0 && Array.isArray(order.line_items)) {
    lineItems = order.line_items.map((li: any) => ({
      id: String(li.id),
      title: li.title,
      sku: li.sku ? li.sku.trim() : '',
      quantity: li.quantity || 1,
      productId: String(li.product_id || ''),
      productTags: '',
      customSupplierMetafield: null,
      vendor: li.vendor || ''
    }));
  }

  // Map items to supplier stores
  const supplierItemsMap: Map<string, { sku: string; quantity: number }[]> = new Map();
  const processedSkus: string[] = [];

  for (const item of lineItems) {
    if (!item.sku) {
      await db.addLog('WARN', `Item '${item.title}' in order ${orderName} has no SKU. Skipping.`, 'orders/create', shopDomain);
      continue;
    }

    processedSkus.push(item.sku);

    let tags = item.productTags;
    let vendor = item.vendor;
    let metafield = item.customSupplierMetafield;

    // Fallback: If tags are empty and sourceStore token exists, fetch via REST API
    if ((!tags || tags.trim() === '') && sourceStore?.accessToken && item.productId) {
      const restProduct = await getProductDetailsREST(shopDomain, sourceStore.accessToken, item.productId);
      if (restProduct.tags) tags = restProduct.tags;
      if (restProduct.vendor) vendor = restProduct.vendor;
    }

    const supplierName = extractSupplierName(tags, metafield, vendor);
    await db.addLog('INFO', `Line item SKU '${item.sku}' (Qty: ${item.quantity}) -> Resolved Supplier Tag/Vendor: "${supplierName || 'None'}"`, 'orders/create', shopDomain);

    let supplierStore = supplierName ? await db.getStoreBySupplierName(supplierName) : null;

    // Fallback: If supplierStore not found by name, check if any connected store is NOT the selling store
    if (!supplierStore) {
      const allStores = await db.getAllStores();
      supplierStore = allStores.find(s => s.shopDomain !== shopDomain) || null;
    }

    if (supplierStore) {
      if (supplierStore.shopDomain === shopDomain) {
        await db.addLog('INFO', `Supplier '${supplierName || supplierStore.supplierName}' is the selling store itself (${shopDomain}). No cross-store dropship needed.`, 'orders/create', shopDomain);
        continue;
      }

      if (!supplierItemsMap.has(supplierStore.shopDomain)) {
        supplierItemsMap.set(supplierStore.shopDomain, []);
      }
      supplierItemsMap.get(supplierStore.shopDomain)!.push({
        sku: item.sku,
        quantity: item.quantity
      });
    } else {
      await db.addLog('WARN', `No connected supplier store matched tag/vendor "${supplierName || 'None'}" for SKU '${item.sku}'`, 'orders/create', shopDomain);
    }
  }

  // If no cross-store orders needed
  if (supplierItemsMap.size === 0) {
    await db.recordOrderSync({
      sourceShopDomain: shopDomain,
      targetShopDomain: 'N/A',
      sourceOrderId: String(order.id || 'N/A'),
      sourceOrderName: orderName,
      targetOrderId: null,
      targetOrderName: null,
      status: 'SKIPPED',
      skus: processedSkus.join(', ') || 'No SKUs',
      error: 'No cross-store supplier items detected for this order.'
    });
    return;
  }

  // Execute dropship order creation on target supplier stores
  for (const [targetShopDomain, items] of supplierItemsMap.entries()) {
    const targetStore = await db.getStoreByDomain(targetShopDomain);
    if (!targetStore) continue;

    await db.addLog('INFO', `🚀 Creating B2B Supplier Order on ${targetStore.name} for ${items.length} item(s)...`, 'orders/create', shopDomain);

    const result = await createSupplierFulfillmentOrder(targetStore, retailerStore, items, orderName);
    const skuListStr = items.map(i => `${i.sku} (x${i.quantity})`).join(', ');

    await db.recordOrderSync({
      sourceShopDomain: shopDomain,
      targetShopDomain,
      sourceOrderId: String(order.id),
      sourceOrderName: orderName,
      targetOrderId: result.orderId || null,
      targetOrderName: result.orderName || null,
      status: result.success ? 'SUCCESS' : 'FAILED',
      skus: skuListStr,
      error: result.error || null
    });

    // Auto-sync inventory across stores to prevent overselling
    for (const item of items) {
      const targetVariant = await findVariantIdBySku(targetStore.shopDomain, targetStore.accessToken, item.sku);
      if (targetVariant) {
        await syncInventoryAcrossStores(shopDomain, item.sku, 0);
      }
    }
  }
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
