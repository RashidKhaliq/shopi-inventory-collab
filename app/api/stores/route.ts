// app/api/stores/route.ts - Multi-Store Management Endpoint
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cleanShopDomain } from '@/lib/shopify';

export async function GET(req: NextRequest) {
  const stores = await db.getAllStores();
  return NextResponse.json({ stores });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { shopDomain, name, accessToken, ownerEmail, supplierName, webhookSecret } = body || {};

    if (!shopDomain || !accessToken || !supplierName || !ownerEmail) {
      return NextResponse.json(
        { error: 'Missing required store fields: shopDomain, accessToken, ownerEmail, supplierName' },
        { status: 400 }
      );
    }

    const domain = cleanShopDomain(shopDomain);
    const store = await db.saveStore({
      shopDomain: domain,
      name: name || `${supplierName} Store`,
      accessToken: accessToken.trim(),
      ownerEmail: ownerEmail.trim(),
      supplierName: supplierName.trim(),
      webhookSecret: webhookSecret ? webhookSecret.trim() : null,
      isActive: true
    });

    await db.addLog('INFO', `Successfully connected store '${store.name}' (${domain}) with Supplier Tag 'Supplier: ${store.supplierName}'`, 'store_management', domain);

    return NextResponse.json({ message: 'Store saved successfully', store });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
