// app/api/test-sync/route.ts - Dropship Test Simulator Endpoint
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { findVariantIdBySku, cleanShopDomain } from '@/lib/shopify';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sourceDomain, targetDomain, sku, orderName } = body || {};

    if (!sourceDomain || !targetDomain || !sku) {
      return NextResponse.json(
        { error: 'Missing required parameters: sourceDomain, targetDomain, sku' },
        { status: 400 }
      );
    }

    const cleanSource = cleanShopDomain(sourceDomain);
    const cleanTarget = cleanShopDomain(targetDomain);
    const cleanSku = sku.trim();

    const targetStore = await db.getStoreByDomain(cleanTarget);
    const sourceStore = await db.getStoreByDomain(cleanSource);

    const trace: string[] = [];
    trace.push(`Initializing test dropship simulation for SKU '${cleanSku}'...`);
    trace.push(`Source Selling Store: ${sourceStore ? sourceStore.name : cleanSource}`);
    trace.push(`Target Supplier Store: ${targetStore ? targetStore.name : cleanTarget}`);

    if (!targetStore || !targetStore.accessToken) {
      trace.push(`✕ Target store '${cleanTarget}' is not connected or missing access token.`);
      return NextResponse.json({
        success: false,
        sku: cleanSku,
        trace
      });
    }

    trace.push(`Querying Shopify GraphQL API on ${targetStore.name} for matching SKU '${cleanSku}'...`);
    const variantResult = await findVariantIdBySku(targetStore.shopDomain, targetStore.accessToken, cleanSku);

    if (variantResult && variantResult.variantId) {
      trace.push(`✓ MATCH SUCCESS! Found Variant ID '${variantResult.variantId}' on ${targetStore.name}`);
      if (variantResult.inventoryItemId) {
        trace.push(`✓ Associated Inventory Item ID: '${variantResult.inventoryItemId}'`);
      }
      return NextResponse.json({
        success: true,
        sku: cleanSku,
        variantId: variantResult.variantId,
        inventoryItemId: variantResult.inventoryItemId,
        trace
      });
    } else {
      trace.push(`✕ SKU '${cleanSku}' was NOT found on ${targetStore.name}. Please create this SKU on ${targetStore.name}.`);
      return NextResponse.json({
        success: false,
        sku: cleanSku,
        trace
      });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
