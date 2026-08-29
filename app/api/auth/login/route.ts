// app/api/auth/login/route.ts - Shopify OAuth Login Redirect
import { NextRequest, NextResponse } from 'next/server';
import { cleanShopDomain } from '@/lib/shopify';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const shop = searchParams.get('shop');

  if (!shop) {
    return NextResponse.json({ error: 'Missing shop query parameter' }, { status: 400 });
  }

  const cleanDomain = cleanShopDomain(shop);
  const apiKey = process.env.SHOPIFY_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'SHOPIFY_API_KEY environment variable is not configured' }, { status: 500 });
  }

  const scopes = 'read_products,write_products,read_orders,write_orders,read_inventory,write_inventory';
  const host = req.headers.get('host') || 'localhost:3000';
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const redirectUri = `${protocol}://${host}/api/auth/callback`;

  const state = Math.random().toString(36).substring(2);
  const installUrl = `https://${cleanDomain}/admin/oauth/authorize?client_id=${apiKey}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  return NextResponse.redirect(installUrl);
}
