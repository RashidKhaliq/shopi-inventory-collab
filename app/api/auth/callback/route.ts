// app/api/auth/callback/route.ts - Shopify OAuth Access Token Exchange
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cleanShopDomain } from '@/lib/shopify';
import axios from 'axios';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const shop = searchParams.get('shop');
  const code = searchParams.get('code');

  if (!shop || !code) {
    return NextResponse.json({ error: 'Missing shop or code parameter' }, { status: 400 });
  }

  const cleanDomain = cleanShopDomain(shop);
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'SHOPIFY_API_KEY or SHOPIFY_API_SECRET missing in environment' }, { status: 500 });
  }

  try {
    const accessTokenRes = await axios.post(`https://${cleanDomain}/admin/oauth/access_token`, {
      client_id: apiKey,
      client_secret: apiSecret,
      code
    });

    const accessToken = accessTokenRes.data?.access_token;
    if (!accessToken) {
      return NextResponse.json({ error: 'Failed to exchange authorization code for access token' }, { status: 400 });
    }

    // Fetch shop details to get owner email and name
    const shopInfoRes = await axios.get(`https://${cleanDomain}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });

    const shopInfo = shopInfoRes.data?.shop || {};
    const supplierName = shopInfo.name ? shopInfo.name.split(' ')[0] : cleanDomain.split('.')[0];

    await db.saveStore({
      shopDomain: cleanDomain,
      name: shopInfo.name || cleanDomain,
      accessToken,
      ownerEmail: shopInfo.email || shopInfo.customer_email || 'owner@example.com',
      supplierName,
      isActive: true
    });

    await db.addLog('INFO', `Successfully connected store '${shopInfo.name}' via Shopify OAuth!`, 'oauth', cleanDomain);

    const host = req.headers.get('host') || 'localhost:3000';
    const protocol = req.headers.get('x-forwarded-proto') || 'https';
    return NextResponse.redirect(`${protocol}://${host}/?connected=true&shop=${cleanDomain}`);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
