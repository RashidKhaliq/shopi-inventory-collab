// app/api/settings/route.ts - Inventory Sync Mode Settings API
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const mode = db.getInventorySyncMode();
  return NextResponse.json({ inventorySyncMode: mode });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { inventorySyncMode } = body || {};

    if (inventorySyncMode !== 'MINUS_INVENTORY' && inventorySyncMode !== 'DRAFT_PRODUCT') {
      return NextResponse.json({ error: 'Invalid mode. Must be MINUS_INVENTORY or DRAFT_PRODUCT' }, { status: 400 });
    }

    db.setInventorySyncMode(inventorySyncMode);
    await db.addLog('INFO', `⚙️ Inventory Sync Mode updated to: ${inventorySyncMode}`, 'settings');

    return NextResponse.json({
      success: true,
      inventorySyncMode
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
