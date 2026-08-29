// app/api/orders/route.ts - Order Sync History API
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const orderSyncs = await db.getOrderSyncs(50);
  return NextResponse.json({ orderSyncs });
}
