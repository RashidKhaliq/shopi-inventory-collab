// app/api/test-sync/route.ts - Dropship Test Simulator Endpoint
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { findVariantIdBySku, cleanShopDomain, createSupplierFulfillmentOrder } from '@/lib/shopify';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sourceDomain, targetDomain, sku, orderName, createTestOrder } = body || {};

    if (!sourceDomain || !targetDomain || !sku) {
      return NextResponse.json(
        { error: 'Missing required parameters: sourceDomain, targetDomain, sku' },
        { status: 400 }
      );
    }

    const cleanSource = cleanShopDomain(sourceDomain);
    const cleanTarget = cleanShopDomain(targetDomain);
    const cleanSku = sku.trim();
    const testOrderName = orderName || `#TEST-ORDER-${Math.floor(1000 + Math.random() * 9000)}`;

    const targetStore = await db.getStoreByDomain(cleanTarget);
    const sourceStore = await db.getStoreByDomain(cleanSource);

    const trace: string[] = [];
    trace.push(`Initializing test dropship simulation for SKU '${cleanSku}'...`);
    trace.push(`Source Selling Store: ${sourceStore ? sourceStore.name : cleanSource}`);
    trace.push(`Target Supplier Store: ${targetStore ? targetStore.name : cleanTarget}`);

    if (!targetStore || !targetStore.accessToken) {
      trace.push(`✕ Target store '${cleanTarget}' is not connected or missing access token.`);
      await db.recordOrderSync({
        sourceShopDomain: cleanSource,
        targetShopDomain: cleanTarget,
        sourceOrderId: `SIM-${Date.now()}`,
        sourceOrderName: testOrderName,
        targetOrderId: null,
        targetOrderName: null,
        status: 'FAILED',
        skus: `${cleanSku} (x1)`,
        error: `Target store '${cleanTarget}' is not connected or missing access token.`
      });

      return NextResponse.json({
        success: false,
        sku: cleanSku,
        trace
      });
    }

    trace.push(`Querying Shopify API on ${targetStore.name} for matching SKU '${cleanSku}'...`);
    const variantResult = await findVariantIdBySku(targetStore.shopDomain, targetStore.accessToken, cleanSku);

    if (!variantResult || !variantResult.variantId) {
      trace.push(`✕ SKU '${cleanSku}' was NOT found on ${targetStore.name}. Please ensure SKU exists on target store.`);
      await db.recordOrderSync({
        sourceShopDomain: cleanSource,
        targetShopDomain: cleanTarget,
        sourceOrderId: `SIM-${Date.now()}`,
        sourceOrderName: testOrderName,
        targetOrderId: null,
        targetOrderName: null,
        status: 'FAILED',
        skus: `${cleanSku} (x1)`,
        error: `SKU '${cleanSku}' was NOT found on supplier store ${targetStore.name}.`
      });

      return NextResponse.json({
        success: false,
        sku: cleanSku,
        trace
      });
    }

    trace.push(`✓ MATCH SUCCESS! Found Variant ID '${variantResult.variantId}' on ${targetStore.name}`);
    if (variantResult.inventoryItemId) {
      trace.push(`✓ Associated Inventory Item ID: '${variantResult.inventoryItemId}'`);
    }

    let createdOrderResult: any = null;

    if (createTestOrder || createTestOrder === undefined) {
      trace.push(`🚀 Creating simulated order on ${targetStore.name}...`);
      const retailerStore = sourceStore || {
        shopDomain: cleanSource,
        name: cleanSource,
        supplierName: cleanSource.split('.')[0]
      };

      createdOrderResult = await createSupplierFulfillmentOrder(
        targetStore,
        retailerStore,
        [{ sku: cleanSku, quantity: 1 }],
        testOrderName
      );

      await db.recordOrderSync({
        sourceShopDomain: cleanSource,
        targetShopDomain: cleanTarget,
        sourceOrderId: `SIM-${Date.now()}`,
        sourceOrderName: testOrderName,
        targetOrderId: createdOrderResult.orderId || null,
        targetOrderName: createdOrderResult.orderName || null,
        status: createdOrderResult.success ? 'SUCCESS' : 'FAILED',
        skus: `${cleanSku} (x1)`,
        error: createdOrderResult.error || null
      });

      if (createdOrderResult.success) {
        trace.push(`🎉 Successfully created B2B Order ${createdOrderResult.orderName} on ${targetStore.name}!`);
        trace.push(`✓ Logged in Order Sync History.`);
      } else {
        trace.push(`✕ Failed to create order on ${targetStore.name}: ${createdOrderResult.error}`);
      }
    }

    return NextResponse.json({
      success: createdOrderResult ? createdOrderResult.success : true,
      sku: cleanSku,
      variantId: variantResult.variantId,
      inventoryItemId: variantResult.inventoryItemId,
      createdOrder: createdOrderResult,
      trace
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
